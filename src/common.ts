import { HumeClient } from 'hume';
import { join } from 'path';
import { homedir } from 'os';
import { mkdir } from 'fs/promises';
import { readConfig, type ConfigData } from './config';
import * as clack from '@clack/prompts';
import createDebug from 'debug';

export const debug = createDebug('hume-cli');
const HUME_DIR = join(homedir(), '.hume');

export const ensureHumeDir = async (): Promise<string> => {
  await mkdir(HUME_DIR, { recursive: true });
  return HUME_DIR;
};

export type ReporterMode = 'json' | 'pretty';

export interface CommonOpts {
  json?: boolean;
  pretty?: boolean;
  apiKey?: string;
  debug?: boolean;
  baseUrl?: string;
}

export interface Reporter {
  mode: string;
  json: (data: unknown) => void;
  info: (message: string) => void;
  withSpinner: <T>(message: string, callback: () => Promise<T>) => Promise<T>;
}

export class ApiKeyNotSetError extends Error {
  constructor() {
    super();
    this.message =
      'No API key provided. You may run `hume login`, set the HUME_API_KEY environment variable, or pass the --api-key flag.';
  }
}

// Removed log function - moved to test files where needed

export const redactFieldsNamedAudio = (k: string, v: unknown) => (k === 'audio' ? '<audio>' : v);

/** A "reporter" reports the results of operations, i.e. the audience is the CLI user.*/
export const makeReporter = (opts: { mode: 'json' | 'pretty' }): Reporter => {
  const spin = clack.spinner();

  if (opts.mode === 'json') {
    const printJson = (data: unknown) =>
      console.log(JSON.stringify(data, redactFieldsNamedAudio, 2));
    return {
      mode: opts.mode,
      json: (data) => printJson(data),
      info: () => {},
      withSpinner: async <T>(_: string, callback: () => Promise<T>): Promise<T> => {
        return await callback();
      },
    };
  }

  return {
    mode: opts.mode,
    json: () => {},
    info: (message) => clack.log.success(message),
    withSpinner: async <T>(message: string, callback: () => Promise<T>): Promise<T> => {
      spin.start(message);
      try {
        const result = await callback();
        spin.stop(message);
        return result;
      } catch (error) {
        spin.stop(`${message} - failed`);
        throw error;
      }
    },
  };
};

export const getSettings = async (
  opts: CommonOpts
): Promise<{
  env: typeof process.env;
  globalConfig: ConfigData;
  session: ConfigData;
  reporter: Reporter;
  hume: HumeClient | null;
}> => {
  const env = process.env;
  const globalConfig = (await readConfig('global')) ?? {};
  const session = (await readConfig('session')) ?? {};

  // Enable debug if requested
  if (opts.debug) {
    debug.enabled = true;
  }

  // Determine reporter mode with priority: opts > session > globalConfig
  let reporterMode: ReporterMode = 'pretty';
  if (opts.json || session.json || globalConfig.json) {
    reporterMode = 'json';
  } else if (opts.pretty || session.pretty) {
    reporterMode = 'pretty';
  }
  debug('Reporter mode: %s', reporterMode);
  const reporter = makeReporter({ mode: reporterMode });
  const apiKey = globalConfig.apiKey ?? session.apiKey ?? env.HUME_API_KEY ?? opts.apiKey;
  const baseUrl = opts.baseUrl ?? env.HUME_BASE_URL ?? session.baseUrl ?? globalConfig.baseUrl;
  const hume = apiKey ? getHumeClient({ apiKey, baseUrl }) : null;
  return {
    hume,
    globalConfig,
    session,
    env,
    reporter,
  };
};

export const getHumeClient = (opts: { apiKey: string; baseUrl?: string }) => {
  const environment = opts.baseUrl || 'https://test-api.hume.ai';
  debug('Creating HumeClient with environment: %s', environment);
  return new HumeClient({
    apiKey: opts.apiKey,
    environment: opts.baseUrl ?? 'https://api.hume.ai',
  });
};
