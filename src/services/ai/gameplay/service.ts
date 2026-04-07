
import { AppSettings, ChatMessage, WorldData, TawaPresetConfig, GameTime } from "../../../types";
import { buildGameplaySystemPrompt, getReinforcementInstruction, buildMVULogicPrompt } from "./prompts";
import { DEFAULT_PRESET_CONFIG } from "../../../constants/tawa_modules";
import { getAiClient } from "../client";
import { GenerateContentResponse } from "@google/genai";
import { vectorService } from "../vectorService";
import { LsrParser } from "../../lsr/LsrParser";
import { ContextCompressor } from "../../../utils/compression";

// Map thinking levels to token counts
const THINKING_BUDGET_MAP: Record<string, number> = {
    'auto': 0,
    'low': 4096,
    'medium': 16384,
    'high': 32768
};

// Task 3.3 Step 2: History Slicing Constant
// Default to 100 as requested by user
const MAX_HISTORY_CONTEXT = 100;
const EMBEDDING_SCHEDULE_INTERVAL = 50;

export const runProxy2InBackground = async (
  input: string,
  storyText: string,
  worldData: WorldData,
  settings: AppSettings,
  proxy2Config: any,
  gameTime: GameTime | undefined,
  onUpdateWorld: (updates: any) => void,
  onStart?: () => void,
  onComplete?: () => void
) => {
  try {
    if (onStart) onStart();
    const lsrTables = LsrParser.parseDefinitions();
    let tableDataString = worldData.lsrData 
        ? LsrParser.stringifyLsrData(worldData.lsrData, lsrTables)
        : "";
    tableDataString = ContextCompressor.minifyLsr(tableDataString);

    const systemInstruction = buildMVULogicPrompt(
      worldData.world,
      worldData.player,
      worldData.entities,
      gameTime,
      tableDataString,
      input,
      storyText
    );

    const aiClient = getAiClient(settings, false, proxy2Config);
    const modelToUse = proxy2Config.model || settings.aiModel;

    console.log("[Dual Proxy] Bắt đầu gọi Proxy 2 (Logic Engine)...");
    
    let response;
    let attempt = 0;
    while (true) {
        try {
            // Thêm timeout 30s cho Proxy 2 để tránh treo
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            response = await aiClient.models.generateContent({
                model: modelToUse,
                contents: "Analyze the events and provide the state updates.",
                config: {
                    temperature: 0.1, // Low temp for logic
                    systemInstruction: systemInstruction
                }
            });
            
            clearTimeout(timeoutId);
            break; // Success
        } catch (error: any) {
            attempt++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`[Dual Proxy] Proxy 2 gặp lỗi (Lần thử ${attempt}):`, errorMessage);
            
            // Nếu là lỗi nghiêm trọng (402, 401, 403, 404), dừng lại
            if (errorMessage.includes('402') || errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('404')) {
                throw error;
            }
            
            // Thử lại ngay lập tức theo yêu cầu của user
            // Để tránh treo trình duyệt nếu lỗi xảy ra liên tục quá nhanh, ta có thể thêm delay 100ms
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    const fullResponse = response.text || "";
    console.log("[Dual Proxy] Proxy 2 phản hồi:\n", fullResponse);

    // Trích xuất JSON
    const jsonMatch = fullResponse.match(/```json\n([\s\S]*?)\n```/);
    let mvuUpdates = {};
    if (jsonMatch && jsonMatch[1]) {
        try {
            mvuUpdates = JSON.parse(jsonMatch[1]);
        } catch (e) {
            console.error("[Dual Proxy] Lỗi parse JSON từ Proxy 2:", e);
        }
    }

    // Trích xuất tableEdit
    const tableEditMatch = fullResponse.match(/<tableEdit>([\s\S]*?)<\/tableEdit>/);
    let parsedEdits = null;
    if (tableEditMatch && tableEditMatch[1]) {
        parsedEdits = LsrParser.parseLsrString(tableEditMatch[1]);
    }

    // Trích xuất time_cost và set_time
    const timeCostMatch = fullResponse.match(/<time_cost>(\d+)<\/time_cost>/);
    const timeCost = timeCostMatch ? parseInt(timeCostMatch[1], 10) : null;

    const setTimeMatch = fullResponse.match(/<set_time>([^<]+)<\/set_time>/);
    const setTime = setTimeMatch ? setTimeMatch[1] : null;

    onUpdateWorld({
        mvuUpdates,
        parsedEdits,
        timeCost,
        setTime
    });

    if (onComplete) onComplete();

  } catch (error) {
    console.error("[Dual Proxy] Lỗi khi chạy Proxy 2:", error);
    if (onComplete) onComplete();
  }
};

export const gameplayAiService = {
  // --- GAMEPLAY STORY GENERATION (With Tawa Protocol) ---

  async generateStoryTurn(
    input: string, 
    history: ChatMessage[], 
    worldData: WorldData, 
    settings: AppSettings,
    presetConfig?: TawaPresetConfig,
    gameTime?: GameTime,
    onMVUUpdate?: (updates: any) => void,
    onProxy2Start?: () => void,
    onProxy2Complete?: () => void
  ): Promise<{ text: string, usage?: Record<string, unknown> }> {
    try {
        const currentTurn = Math.floor(history.length / 2);
        
        // --- COMPRESSION: Clean user input ---
        const cleanedInput = ContextCompressor.cleanText(input);

        // Task 3.3 Step 1: Vector Search (RAG)
        // Find relevant memories from the distant past - ONLY EVERY X TURNS to save API quota
        // OPTIMIZATION: Only search if history is longer than context window, otherwise it's redundant
        const shouldCallEmbedding = settings.enableVectorMemory && currentTurn > 0 && currentTurn % EMBEDDING_SCHEDULE_INTERVAL === 0;
        const shouldSearchEmbedding = shouldCallEmbedding && history.length >= MAX_HISTORY_CONTEXT;
        
        const similarVectors = shouldSearchEmbedding 
            ? await vectorService.searchSimilarVectors(cleanedInput, settings, 5)
            : [];
        
        const relevantMemories = similarVectors
            .map(v => `[${new Date(v.timestamp).toLocaleString()}] ${v.role === 'user' ? 'User' : 'AI'}: ${v.text}`)
            .join('\n\n');

        // Task 3.3 Step 2: Slice History
        // Use user-defined history count or fallback to default
        const historyCount = worldData.config.contextConfig?.recentHistoryCount || MAX_HISTORY_CONTEXT;
        const slicedHistory = history.slice(-historyCount);

        // --- COMPRESSION: Clean History (Safe compression only) ---
        const compressedHistory = slicedHistory.map(msg => ({
            ...msg,
            text: ContextCompressor.cleanText(msg.text)
        }));

        // Task: Relevance-based Entity Sorting (Prioritizing Female NPCs)
        const maxEntities = worldData.config.contextConfig?.maxEntities || 20;
        
        // Simple relevance scoring: Check if entity name appears in recent history or current input
        const recentText = [...compressedHistory.map(m => m.text), cleanedInput].join(' ').toLowerCase();
        
        const sortedEntities = [...worldData.entities].sort((a, b) => {
            const aMentioned = recentText.includes(a.name.toLowerCase()) ? 1 : 0;
            const bMentioned = recentText.includes(b.name.toLowerCase()) ? 1 : 0;
            
            // Priority 1: Mentioned in recent context
            if (aMentioned !== bMentioned) return bMentioned - aMentioned;
            
            // Priority 2: Gender Priority (Female first)
            const aIsFemale = a.gender === 'Nữ' || a.description?.toLowerCase().includes('nữ') || a.description?.toLowerCase().includes('female') ? 1 : 0;
            const bIsFemale = b.gender === 'Nữ' || b.description?.toLowerCase().includes('nữ') || b.description?.toLowerCase().includes('female') ? 1 : 0;
            if (aIsFemale !== bIsFemale) return bIsFemale - aIsFemale;

            // Priority 3: NPCs over Items
            if (a.type !== b.type) {
                if (a.type === 'NPC') return -1;
                if (b.type === 'NPC') return 1;
            }
            
            return 0;
        });

        const limitedEntities = sortedEntities.slice(0, maxEntities);

        // Task: Stringify LSR Data for AI
        const lsrTables = LsrParser.parseDefinitions();
        let tableDataString = worldData.lsrData 
            ? LsrParser.stringifyLsrData(worldData.lsrData, lsrTables)
            : "";
        
        // --- COMPRESSION: Minify LSR Data ---
        tableDataString = ContextCompressor.minifyLsr(tableDataString);

        // Use provided config or fallback to default
        const activeConfig = presetConfig || DEFAULT_PRESET_CONFIG;

        // Dual Proxy Logic
        const activeProxies = settings.proxies?.filter(p => p.isActive) || [];
        const isDualProxy = settings.useDualProxyMVU && activeProxies.length >= 2;
        
        const proxy1Config = activeProxies.find(p => p.id === settings.activeProxyId) || activeProxies[0];
        let proxy2Config = null;

        if (isDualProxy) {
            // proxy1Config already set above as primary or first active
            proxy2Config = activeProxies.find(p => p.id !== proxy1Config?.id) || activeProxies[1];
            console.log(`[Dual Proxy] Kích hoạt cơ chế 2 Proxy. Proxy 1: ${proxy1Config?.url}, Proxy 2: ${proxy2Config?.url}`);
        } else {
            console.log("[Dual Proxy] Sử dụng cơ chế 1 Proxy (Legacy).");
        }

        const systemInstruction = buildGameplaySystemPrompt(
          worldData.world,
          worldData.player,
          limitedEntities, // Detailed list (limited)
          worldData.entities, // Full list (minimalist)
          relevantMemories, // Task 3.3 Step 3: Inject Memories
          currentTurn,
          activeConfig, 
          worldData.config,
          settings, // NEW: Pass settings
          gameTime,
          cleanedInput,
          worldData.summary ? ContextCompressor.cleanText(worldData.summary) : undefined, // CLEANED: Safe compression
          tableDataString, // NEW: Pass LSR data
          isDualProxy && currentTurn > 0 // isStoryOnly = true ONLY if Dual Proxy AND NOT turn 0
        );

        // 2. Prepare Config
        // Determine effective proxy and model
        let activeProxy = proxy1Config;
        if (!activeProxy && (settings.proxyEnabled || settings.proxyUrl)) {
            activeProxy = {
                id: 'legacy',
                name: settings.proxyName || 'Legacy Proxy',
                url: settings.proxyUrl || '',
                key: settings.proxyKey || '',
                model: settings.proxyModel || '',
                models: settings.proxyModels || [],
                isActive: true,
                type: (settings.proxyUrl?.includes('moonshot') || settings.proxyUrl?.includes('kimi')) ? 'openai' : (settings.proxyEnabled ? 'openai' : 'google')
            };
        }

        const modelToUse = (activeProxy && activeProxy.model) 
            ? activeProxy.model 
            : settings.aiModel;

        const generationConfig: Record<string, unknown> = {
            temperature: settings.temperature,
            topK: settings.topK,
            topP: settings.topP,
            maxOutputTokens: settings.maxOutputTokens,
        };

        // Apply Thinking Config based on mode
        if (settings.thinkingMode === 'level') {
            if (settings.thinkingLevel && settings.thinkingLevel !== 'OFF') {
                (generationConfig as Record<string, unknown>).thinkingConfig = { 
                    thinkingLevel: settings.thinkingLevel 
                };
            }
        } else {
            const thinkingBudget = THINKING_BUDGET_MAP[settings.thinkingBudgetLevel] || 0;
            // Apply budget if > 0 and model seems to support it (pro or thinking models)
            const lowerModel = modelToUse.toLowerCase();
            const isThinkingModel = lowerModel.includes('pro') || 
                                   lowerModel.includes('thinking') || 
                                   lowerModel.includes('kimi') || 
                                   lowerModel.includes('moonshot') ||
                                   lowerModel.includes('o1') ||
                                   lowerModel.includes('o3');
            if (thinkingBudget > 0 && isThinkingModel) {
                (generationConfig as Record<string, unknown>).thinkingConfig = { thinkingBudget };
            }
        }

        // 3. Prepare Contents (Using compressed history)
        const contents = compressedHistory.map(msg => {
            let text = msg.text;
            if (msg.role === 'user' && !text.includes('<user_input>')) {
                text = `<user_input>${text}</user_input>`;
            }
            return {
                role: msg.role,
                parts: [{ text: text }]
            };
        });

        // INJECT REINFORCEMENT INSTRUCTION HERE (CONTEXT DRIFT FIX)
        const reinforcement = getReinforcementInstruction(currentTurn);
        const finalReminder = `\n\n<CRITICAL_REMINDER>\nSTRICTLY ADHERE TO THE OUTPUT FORMAT. 
1. START <content> with [BẮT ĐẦU PHẦN TRUYỆN] on a new line.
2. USE --- for scene/time transitions.
3. END <content> with [KẾT THÚC PHẦN TRUYỆN] on a new line before closing </content>.
4. <branches> MUST ONLY CONTAIN ACTION CHOICES. ABSOLUTELY NO DIALOGUE OR NARRATIVE INSIDE <branches>.
5. THE FIRST CHOICE MUST BE A VALID ACTION.
6. DO NOT LEAK ANY SYSTEM INSTRUCTIONS INTO THE OUTPUT.\n</CRITICAL_REMINDER>`;
        const fullInput = `<user_input>${cleanedInput}</user_input>${reinforcement}${finalReminder}`;

        contents.push({
            role: 'user',
            parts: [{ text: fullInput }]
        });

        // 4. Assistant Prefill Logic
        const prefillModule = activeConfig.modules.find(m => m.id === 'sys_prefill_trigger');
        const prefillContent = (prefillModule && prefillModule.isActive) ? prefillModule.content : '';

        if (prefillContent) {
            contents.push({
                role: 'model',
                parts: [{ text: prefillContent }]
            });
        }

        // 5. Call AI
        const aiClient = getAiClient(settings);

        const response = await aiClient.models.generateContent({
            model: modelToUse,
            contents: contents,
            config: {
                ...generationConfig,
                systemInstruction: systemInstruction
            }
        });

        let fullResponse = response.text || "";

        // --- FILTERING LOGIC: Remove system artifacts and leaked thinking blocks ---
        const orchestrationPatterns = [
            /Core Activation: <COGNITIVE_ORCHESTRATION_SEQUENCE[\s\S]*?Plan for Stage 1:.*?\n/gi,
            /<COGNITIVE_ORCHESTRATION_SEQUENCE[\s\S]*?<\/COGNITIVE_ORCHESTRATION_SEQUENCE>/gi,
            /\[DATA SYNC\][\s\S]*?\[SYNCHRONIZATION\]/gi,
            /\[Loading Constitution\][\s\S]*?\[Checked\]/gi,
            /\[Loading Variables\][\s\S]*?\[Done\]/gi,
            /<thinking>[\s\S]*?<\/thinking>/gi, 
        ];

        orchestrationPatterns.forEach(pattern => {
            fullResponse = fullResponse.replace(pattern, "");
        });

        fullResponse = fullResponse.trim();

        // LAST RESORT: Nếu phản hồi trống sau khi lọc, nhưng AI thực sự có trả về gì đó
        if (!fullResponse && response.text && response.text.trim().length > 0) {
            // Thử lấy lại văn bản gốc nhưng bỏ qua các thẻ kỹ thuật rõ ràng nhất
            fullResponse = response.text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
        }

        if (prefillContent && !fullResponse.startsWith(prefillContent)) {
            fullResponse = prefillContent + fullResponse;
        }

        // Task 3.3 Step 4: Save Vectors Async (Fire and forget) - ONLY EVERY X TURNS
        if (shouldCallEmbedding) {
            (async () => {
                 const userMsgId = `msg-${Date.now()}-user`;
                 const aiMsgId = `msg-${Date.now() + 1}-model`;
                 await vectorService.saveVector(userMsgId, cleanedInput, 'user', settings);
                 if (fullResponse) {
                     await vectorService.saveVector(aiMsgId, fullResponse, 'model', settings);
                 }
            })();
        }

        // Dual Proxy: Call Proxy 2
        if (isDualProxy && proxy2Config && onMVUUpdate) {
            await runProxy2InBackground(
                cleanedInput,
                fullResponse,
                worldData,
                settings,
                proxy2Config,
                gameTime,
                onMVUUpdate,
                onProxy2Start,
                onProxy2Complete
            );
        }

        return { 
            text: fullResponse || "Hệ thống không phản hồi. Vui lòng thử lại.", 
            usage: response.usageMetadata 
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let userFriendlyMessage = `[LỖI HỆ THỐNG: Không thể nhận phản hồi từ AI. Chi tiết: ${errorMessage}]`;
        
        if (errorMessage.toLowerCase().includes('safety') || errorMessage.toLowerCase().includes('blocked')) {
            userFriendlyMessage = `[CẢNH BÁO AN TOÀN: Phản hồi của AI đã bị chặn bởi bộ lọc nội dung của Google. Điều này thường xảy ra khi nội dung truyện quá nhạy cảm hoặc vi phạm chính sách. Bạn có thể thử 'Regenerate' với hành động khác hoặc điều chỉnh 'Safety Settings' trong phần Cài đặt.]`;
        } else if (errorMessage.includes('PAYMENT_REQUIRED') || errorMessage.includes('402')) {
            userFriendlyMessage = `[LỖI THANH TOÁN (402): Model này yêu cầu API Key có trả phí (Paid Tier) hoặc đã hết hạn mức miễn phí. Vui lòng vào Cài đặt > API & Proxy để chọn API Key mới bằng nút 'Chọn API Key (Paid)'.]`;
        } else if (errorMessage.toLowerCase().includes('quota') || errorMessage.toLowerCase().includes('rate limit')) {
            userFriendlyMessage = `[GIỚI HẠN LƯU LƯỢNG: Bạn đã đạt giới hạn yêu cầu của AI. Vui lòng đợi một lát rồi thử lại.]`;
        } else if (errorMessage.includes('404') || errorMessage.toLowerCase().includes('not found')) {
            userFriendlyMessage = `[LỖI MODEL (404): Không tìm thấy Model AI yêu cầu. Vui lòng kiểm tra lại tên Model trong phần Cài đặt AI & Proxy. Nếu dùng Proxy, hãy thử 'Tải danh sách Model' lại.]`;
        }

        return { 
            text: `<span style="color: #ef4444; font-style: italic; font-size: 0.875rem;">${userFriendlyMessage}</span>`,
            usage: null
        };
    }
  },

  // --- STREAMING STORY GENERATION ---
  async *generateStoryTurnStream(
    input: string, 
    history: ChatMessage[], 
    worldData: WorldData, 
    settings: AppSettings,
    presetConfig?: TawaPresetConfig,
    gameTime?: GameTime,
    onMVUUpdate?: (updates: any) => void,
    onProxy2Start?: () => void,
    onProxy2Complete?: () => void
  ): AsyncGenerator<GenerateContentResponse | string, void, unknown> {
    try {
        const currentTurn = Math.floor(history.length / 2);
        const activeConfig = presetConfig || DEFAULT_PRESET_CONFIG;

        // --- COMPRESSION: Clean user input ---
        const cleanedInput = ContextCompressor.cleanText(input);

        // Task 3.3 Step 1: Vector Search (RAG) - ONLY EVERY X TURNS
        // OPTIMIZATION: Only search if history is longer than context window, otherwise it's redundant
        const shouldCallEmbeddingStream = settings.enableVectorMemory && currentTurn > 0 && currentTurn % EMBEDDING_SCHEDULE_INTERVAL === 0;
        const shouldSearchEmbeddingStream = shouldCallEmbeddingStream && history.length >= MAX_HISTORY_CONTEXT;
        
        const similarVectors = shouldSearchEmbeddingStream 
            ? await vectorService.searchSimilarVectors(cleanedInput, settings, 5)
            : [];
            
        const relevantMemories = similarVectors
            .map(v => `[${new Date(v.timestamp).toLocaleString()}] ${v.role === 'user' ? 'User' : 'AI'}: ${v.text}`)
            .join('\n\n');

        // Task 3.3 Step 2: Slice History
        const historyCount = worldData.config.contextConfig?.recentHistoryCount || MAX_HISTORY_CONTEXT;
        const slicedHistory = history.slice(-historyCount);

        // --- COMPRESSION: Clean History (Safe compression only) ---
        const compressedHistory = slicedHistory.map(msg => ({
            ...msg,
            text: ContextCompressor.cleanText(msg.text)
        }));

        // Task: Relevance-based Entity Sorting (Prioritizing Female NPCs)
        const maxEntities = worldData.config.contextConfig?.maxEntities || 20;
        
        // Simple relevance scoring: Check if entity name appears in recent history or current input
        const recentText = [...compressedHistory.map(m => m.text), cleanedInput].join(' ').toLowerCase();
        
        const sortedEntities = [...worldData.entities].sort((a, b) => {
            const aMentioned = recentText.includes(a.name.toLowerCase()) ? 1 : 0;
            const bMentioned = recentText.includes(b.name.toLowerCase()) ? 1 : 0;
            
            // Priority 1: Mentioned in recent context
            if (aMentioned !== bMentioned) return bMentioned - aMentioned;
            
            // Priority 2: Gender Priority (Female first)
            const aIsFemale = a.gender === 'Nữ' || a.description?.toLowerCase().includes('nữ') || a.description?.toLowerCase().includes('female') ? 1 : 0;
            const bIsFemale = b.gender === 'Nữ' || b.description?.toLowerCase().includes('nữ') || b.description?.toLowerCase().includes('female') ? 1 : 0;
            if (aIsFemale !== bIsFemale) return bIsFemale - aIsFemale;

            // Priority 3: NPCs over Items
            if (a.type !== b.type) {
                if (a.type === 'NPC') return -1;
                if (b.type === 'NPC') return 1;
            }
            
            return 0; // Keep original order for the rest
        });

        const limitedEntities = sortedEntities.slice(0, maxEntities);

        // Task: Stringify LSR Data for AI
        const lsrTables = LsrParser.parseDefinitions();
        let tableDataString = worldData.lsrData 
            ? LsrParser.stringifyLsrData(worldData.lsrData, lsrTables)
            : "";
        
        // --- COMPRESSION: Minify LSR Data ---
        tableDataString = ContextCompressor.minifyLsr(tableDataString);

        // Dual Proxy Logic
        const activeProxies = settings.proxies?.filter(p => p.isActive) || [];
        const isDualProxy = settings.useDualProxyMVU && activeProxies.length >= 2;
        
        const proxy1Config = activeProxies.find(p => p.id === settings.activeProxyId) || activeProxies[0];
        let proxy2Config = null;

        if (isDualProxy) {
            // Nếu có 2 proxy, proxy 1 là cái đang chọn, proxy 2 là cái còn lại
            proxy2Config = activeProxies.find(p => p.id !== proxy1Config?.id) || activeProxies[1];
            console.log(`[Dual Proxy] Kích hoạt cơ chế 2 Proxy (Stream). Proxy 1: ${proxy1Config?.url}, Proxy 2: ${proxy2Config?.url}`);
        } else {
            console.log("[Dual Proxy] Sử dụng cơ chế 1 Proxy (Legacy Stream).");
        }

        const systemInstruction = buildGameplaySystemPrompt(
          worldData.world,
          worldData.player,
          limitedEntities, // Inject Memories
          worldData.entities, // Full list (minimalist)
          relevantMemories, // Inject Memories
          currentTurn,
          activeConfig, 
          worldData.config,
          settings, // NEW: Pass settings
          gameTime,
          cleanedInput,
          worldData.summary ? ContextCompressor.cleanText(worldData.summary) : undefined, // CLEANED: Safe compression
          tableDataString, // NEW: Pass LSR data
          isDualProxy && currentTurn > 0 // isStoryOnly = true ONLY if Dual Proxy AND NOT turn 0
        );

        // Determine effective proxy and model
        let activeProxy = proxy1Config;
        if (!activeProxy && (settings.proxyEnabled || settings.proxyUrl)) {
            activeProxy = {
                id: 'legacy',
                name: settings.proxyName || 'Legacy Proxy',
                url: settings.proxyUrl || '',
                key: settings.proxyKey || '',
                model: settings.proxyModel || '',
                models: settings.proxyModels || [],
                isActive: true,
                type: (settings.proxyUrl?.includes('moonshot') || settings.proxyUrl?.includes('kimi')) ? 'openai' : (settings.proxyEnabled ? 'openai' : 'google')
            };
        }

        const modelToUse = (activeProxy && activeProxy.model) 
            ? activeProxy.model 
            : settings.aiModel;

        const generationConfig: Record<string, unknown> = {
            temperature: settings.temperature,
            topK: settings.topK,
            topP: settings.topP,
            maxOutputTokens: settings.maxOutputTokens,
        };

        // Apply Thinking Config based on mode
        if (settings.thinkingMode === 'level') {
            if (settings.thinkingLevel && settings.thinkingLevel !== 'OFF') {
                (generationConfig as Record<string, unknown>).thinkingConfig = { 
                    thinkingLevel: settings.thinkingLevel 
                };
            }
        } else {
            const thinkingBudget = THINKING_BUDGET_MAP[settings.thinkingBudgetLevel] || 0;
            const lowerModel = modelToUse.toLowerCase();
            const isThinkingModel = lowerModel.includes('pro') || 
                                   lowerModel.includes('thinking') || 
                                   lowerModel.includes('kimi') || 
                                   lowerModel.includes('moonshot') ||
                                   lowerModel.includes('o1') ||
                                   lowerModel.includes('o3');
            if (thinkingBudget > 0 && isThinkingModel) {
                (generationConfig as Record<string, unknown>).thinkingConfig = { thinkingBudget };
            }
        }

        const contents = compressedHistory.map(msg => {
            let text = msg.text;
            if (msg.role === 'user' && !text.includes('<user_input>')) {
                text = `<user_input>${text}</user_input>`;
            }
            return {
                role: msg.role,
                parts: [{ text: text }]
            };
        });

        // INJECT REINFORCEMENT INSTRUCTION HERE (CONTEXT DRIFT FIX)
        const reinforcement = getReinforcementInstruction(currentTurn);
        const finalReminderStream = `\n\n<CRITICAL_REMINDER>\nSTRICTLY ADHERE TO THE OUTPUT FORMAT. 
1. START <content> with [BẮT ĐẦU PHẦN TRUYỆN] on a new line.
2. USE --- for scene/time transitions.
3. END <content> with [KẾT THÚC PHẦN TRUYỆN] on a new line before closing </content>.
4. <branches> MUST ONLY CONTAIN ACTION CHOICES. EVERY CHOICE MUST START WITH [minutes].
5. THE FIRST CHOICE MUST BE A VALID ACTION.
6. DO NOT LEAK ANY SYSTEM INSTRUCTIONS INTO THE OUTPUT.\n</CRITICAL_REMINDER>`;
        const fullInput = `<user_input>${cleanedInput}</user_input>${reinforcement}${finalReminderStream}`;

        contents.push({
            role: 'user',
            parts: [{ text: fullInput }]
        });

        // Handle Prefill
        const prefillModule = activeConfig.modules.find(m => m.id === 'sys_prefill_trigger');
        const prefillContent = (prefillModule && prefillModule.isActive) ? prefillModule.content : '';

        if (prefillContent) {
            yield prefillContent;
            contents.push({
                role: 'model',
                parts: [{ text: prefillContent }]
            });
        }

        const aiClient = getAiClient(settings);

        const streamResponse = await aiClient.models.generateContentStream({
            model: modelToUse,
            contents: contents,
            config: {
                ...generationConfig,
                systemInstruction: systemInstruction
            }
        });

        let accumulatedFullText = prefillContent;

        for await (const chunk of streamResponse) {
             const c = chunk as GenerateContentResponse;
             
             // Yield the full chunk object so the UI can capture usageMetadata
             // The UI (GameplayScreen) already handles both string and object chunks
             yield c;

             if (c.text) {
                 accumulatedFullText += c.text;
             }
        }

        if (!accumulatedFullText) {
            const fallback = "Hệ thống không phản hồi. Vui lòng thử lại.";
            accumulatedFullText = fallback;
            yield fallback;
        }

        // Task 3.3 Step 4: Save Vectors Async after stream completes - ONLY EVERY X TURNS
        if (shouldCallEmbeddingStream) {
            (async () => {
                 const userMsgId = `msg-${Date.now()}-user`;
                 const aiMsgId = `msg-${Date.now() + 1}-model`;
                 await vectorService.saveVector(userMsgId, cleanedInput, 'user', settings);
                 if (accumulatedFullText) {
                     await vectorService.saveVector(aiMsgId, accumulatedFullText, 'model', settings);
                 }
            })();
        }

        // Dual Proxy: Call Proxy 2
        if (isDualProxy && proxy2Config && onMVUUpdate) {
            await runProxy2InBackground(
                cleanedInput,
                accumulatedFullText,
                worldData,
                settings,
                proxy2Config,
                gameTime,
                onMVUUpdate,
                onProxy2Start,
                onProxy2Complete
            );
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('PAYMENT_REQUIRED') || errorMessage.includes('402')) {
            yield `<span style="color: #ef4444;">[LỖI THANH TOÁN (402): Model này yêu cầu API Key có trả phí (Paid Tier) hoặc đã hết hạn mức miễn phí. Vui lòng vào Cài đặt > API & Proxy để chọn API Key mới bằng nút 'Chọn API Key (Paid)'.]</span>`;
        } else if (errorMessage.includes('404') || errorMessage.toLowerCase().includes('not found')) {
            yield `<span style="color: #ef4444;">[LỖI MODEL (404): Không tìm thấy Model AI. Vui lòng kiểm tra lại Cài đặt AI & Proxy.]</span>`;
        } else if (errorMessage.toLowerCase().includes('safety') || errorMessage.toLowerCase().includes('blocked')) {
            yield `<span style="color: #ef4444;">[CẢNH BÁO AN TOÀN: Phản hồi của AI đã bị chặn bởi bộ lọc nội dung. Bạn có thể thử 'Regenerate' hoặc điều chỉnh 'Safety Settings' trong Cài đặt.]</span>`;
        } else {
            yield `<span style="color: #ef4444;">[LỖI HỆ THỐNG: ${errorMessage}]</span>`;
        }
    }
  },

};
