
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  details?: any;
}

class LogService {
  private logs: LogEntry[] = [];
  private listeners: ((logs: LogEntry[]) => void)[] = [];
  private maxLogs = 200;

  constructor() {
    // Capture original console methods
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    const originalConsoleLog = console.log;
    const originalConsoleInfo = console.info;
    const originalConsoleDebug = console.debug;

    const formatArgs = (args: any[]) => {
      return args.map(arg => {
        try {
          if (arg instanceof Error) {
            return `${arg.name}: ${arg.message}\n${arg.stack}`;
          }
          if (typeof arg === 'object') {
            // Handle circular references and other JSON.stringify issues
            const cache = new Set();
            return JSON.stringify(arg, (key, value) => {
              if (typeof value === 'object' && value !== null) {
                if (cache.has(value)) return '[Circular]';
                cache.add(value);
              }
              return value;
            }, 2);
          }
          return String(arg);
        } catch (e) {
          return `[Unserializable: ${String(arg)}]`;
        }
      }).join(' ');
    };

    console.error = (...args: any[]) => {
      this.addLog('error', formatArgs(args), args);
      originalConsoleError.apply(console, args);
    };

    console.warn = (...args: any[]) => {
      this.addLog('warn', formatArgs(args), args);
      originalConsoleWarn.apply(console, args);
    };

    console.log = (...args: any[]) => {
      this.addLog('info', formatArgs(args), args);
      originalConsoleLog.apply(console, args);
    };

    console.info = (...args: any[]) => {
      this.addLog('info', formatArgs(args), args);
      originalConsoleInfo.apply(console, args);
    };

    console.debug = (...args: any[]) => {
      this.addLog('debug', formatArgs(args), args);
      originalConsoleDebug.apply(console, args);
    };

    // Capture global unhandled errors
    window.addEventListener('error', (event) => {
      this.addLog('error', `Global Error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`, event.error);
    });

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.addLog('error', `Unhandled Promise Rejection: ${event.reason}`, event.reason);
    });
  }

  private addLog(level: LogLevel, message: string, details?: any) {
    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
      level,
      message,
      details
    };

    this.logs = [entry, ...this.logs].slice(0, this.maxLogs);
    this.notify();
  }

  public getLogs(): LogEntry[] {
    return this.logs;
  }

  public clearLogs() {
    this.logs = [];
    this.notify();
  }

  public subscribe(listener: (logs: LogEntry[]) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify() {
    this.listeners.forEach(l => l(this.logs));
  }
}

export const logService = new LogService();
export type { LogEntry, LogLevel };
