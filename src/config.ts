import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'path';
import { exec } from 'node:child_process';
import * as t from 'typanion';
import * as clack from '@clack/prompts';
import open from 'open';

import {
  ensureHumeDir,
  type CommonOpts,
  type ReporterMode,
  getSettings,
  makeReporter,
} from './common';

export const CONFIG_FILE = 'config.json';

export type ConfigData = {
  tts?: {
    voiceName?: string;
    voiceId?: string;
    description?: string;
    outputDir?: string;
    prefix?: string;
    play?: 'all' | 'first' | 'off';
    format?: 'wav' | 'mp3' | 'pcm';
    numGenerations?: number;
    last?: boolean;
    lastIndex?: number;
    playCommand?: string;
    presetVoice?: boolean;
    speed?: number;
    trailingSilence?: number;
    streaming?: boolean;
  };
  json?: boolean;
  pretty?: boolean;
  apiKey?: string;
  baseUrl?: string;
};
export const configValidators = {
  'tts.voiceName': t.isString(),
  'tts.voiceId': t.isString(),
  'tts.description': t.isString(),
  'tts.outputDir': t.isString(),
  'tts.prefix': t.isString(),
  'tts.play': t.isEnum(['all', 'first', 'off'] as const),
  'tts.format': t.isEnum(['wav', 'mp3', 'pcm'] as const),
  'tts.playCommand': t.isString(),
  'tts.presetVoice': t.isBoolean(),
  'tts.speed': t.cascade(t.isNumber(), t.isInInclusiveRange(0.25, 3.0)),
  'tts.trailingSilence': t.cascade(t.isNumber(), t.isInInclusiveRange(0.0, 5.0)),
  'tts.streaming': t.isBoolean(),
  json: t.isBoolean(),
  pretty: t.isBoolean(),
  apiKey: t.isString(),
};

const readJsonFile = async <T>(path: string): Promise<T | null> => {
  try {
    const data = await readFile(path, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const writeJsonFile = async <T>(path: string, data: T): Promise<void> => {
  await writeFile(path, JSON.stringify(data, null, 2));
};

const getFilePath = async (filename: string): Promise<string> => {
  return join(await ensureHumeDir(), filename);
};

const processStartedAt = async (pid: number): Promise<number> => {
  if (process.platform === 'win32') {
    const startTime = await new Promise<string>((resolve, reject) => {
      const cmd = `powershell.exe -Command "Get-Process -Id ${pid} | Select-Object @{Name='StartTime';Expression={$_.StartTime.ToString('o')}} | Format-Table -HideTableHeaders"`;
      const cp = exec(cmd);
      let data = '';
      let errData = '';
      cp.stdout?.on('data', (chunk) => {
        data += chunk;
      });
      cp.stderr?.on('data', (chunk) => {
        errData += chunk;
      });
      cp.on('exit', (code) => {
        if (code === 0) {
          resolve(data);
        } else {
          reject(
            new Error(
              `PowerShell command exited with code ${code}\noutput: ${data}\nerror: ${errData}`
            )
          );
        }
      });
    });
    return new Date(startTime.trim()).getTime();
  }

  // Use exec for better cross-platform compatibility
  return new Promise((resolve, reject) => {
    exec(`ps -p ${pid} -o lstart=`, (error, stdout) => {
      if (error) {
        const errorMsg = error.message.includes('[')
          ? Buffer.from(error.message.split('[')[1].split(']')[0].split(',').map(Number)).toString()
          : error.message;
        reject(new Error(errorMsg));
        return;
      }
      resolve(new Date(stdout.trim()).getTime());
    });
  });
};

const getSessionPath = async (): Promise<string> => {
  const parentStartedAt = await processStartedAt(process.ppid);
  return `session.${parentStartedAt}.json`;
};

const getConfigPath = async (type: 'global' | 'session'): Promise<string> => {
  return getFilePath(type === 'global' ? CONFIG_FILE : await getSessionPath());
};

export const readConfig = async (type: 'global' | 'session'): Promise<ConfigData | null> => {
  return readJsonFile(await getConfigPath(type));
};

const showConfig =
  (type: 'global' | 'session') =>
  async (opts: CommonOpts = {}): Promise<void> => {
    // Deliberately create a JSON reporter regardless of config settings
    // When showing config, we always want to use JSON output format for consistency
    const reporter = makeReporter({ mode: 'json' });
    const { globalConfig, session } = await getSettings(opts);
    if (type === 'global') {
      reporter.json(globalConfig ?? {});
    }
    if (type === 'session') {
      reporter.json(session ?? {});
    }
  };

const parseConfigKV = (name: keyof typeof configValidators, value: string): unknown => {
  const validator = configValidators[name];
  const errors: Array<string> = [];
  const coercions: Array<t.Coercion> = [];
  const input = { [name]: value };
  // typanion has a weird "coercions" API -- if you
  // want to parse "2" as a number, you have to pass
  // it beneath a key in an object, and call a
  // "coercion" to mutate it.
  const inputValidator = t.isObject({
    [name]: validator,
  });
  if (!inputValidator(input, { errors, coercions })) {
    // Include expected value types in error message
    let validValues = '';
    if (name === 'tts.play') {
      validValues = '\nValid values: "all", "first", or "off"';
    } else if (name === 'tts.format') {
      validValues = '\nValid values: "wav", "mp3", or "pcm"';
    } else if (name === 'tts.speed') {
      validValues = '\nValid values: number between 0.25 and 3.0';
    } else if (name === 'tts.trailingSilence') {
      validValues = '\nValid values: number between 0.0 and 5.0';
    }

    throw new Error(`Invalid value for ${name}: "${value}"${validValues}\n${errors.join('\n')}`);
  }
  for (const [_, c] of coercions) c();
  return input[name];
};

const editConfigKV = (
  name: keyof typeof configValidators,
  value: unknown,
  config: ConfigData
): void => {
  if (name.startsWith('tts.')) {
    const innerName = name.slice('tts.'.length) as keyof ConfigData['tts'];
    if (!config.tts) {
      config.tts = {} as ConfigData['tts'];
    }
    // @ts-ignore
    config.tts[innerName] = value;
  } else {
    // @ts-ignore
    config[name] = value;
  }
};

type SetConfigOpts = CommonOpts & {
  name: keyof typeof configValidators;
  value: string;
};

const setConfig =
  (type: 'global' | 'session') =>
  async (opts: SetConfigOpts): Promise<void> => {
    const { globalConfig, session, reporter } = await getSettings(opts);
    const currentConfig = type === 'global' ? globalConfig : session;
    const configPath = await getConfigPath(type);

    const value = parseConfigKV(opts.name, opts.value);
    editConfigKV(opts.name, value, currentConfig);
    await writeJsonFile(configPath, currentConfig);
    reporter.info(`${type} config updated`);
    reporter.json({ [opts.name]: value });
  };

const clearConfig =
  (type: 'global' | 'session') =>
  async (opts: CommonOpts = {}): Promise<void> => {
    const { reporter } = await getSettings(opts);
    const configPath = await getConfigPath(type);
    await writeJsonFile(configPath, {});
    reporter.info(`${type} config cleared`);
  };

// Public API

export const login = async (opts: CommonOpts = {}): Promise<void> => {
  const { reporter } = await getSettings(opts);

  const shouldOpenBrowser = await clack.confirm({
    message: 'Would you like to open the Hume API key settings page in your browser?',
  });

  if (clack.isCancel(shouldOpenBrowser)) {
    process.exit(0);
  }

  if (shouldOpenBrowser) {
    const apiKeysUrl = 'https://platform.hume.ai/settings/keys';
    reporter.info(`Opening ${apiKeysUrl} in your browser...`);
    await open(apiKeysUrl);
  }

  const apiKey = await clack.text({
    message: 'Enter your Hume API key:',
    validate(value) {
      if (!value) return 'Please enter an API key';
      return;
    },
  });

  if (clack.isCancel(apiKey)) {
    process.exit(0);
  }

  await setGlobalConfig({
    name: 'apiKey',
    value: apiKey as string,
    pretty: true,
  });

  reporter.info('Successfully logged in!');
};

export const showSession = showConfig('session');
export const showGlobalConfig = showConfig('global');
export const setSessionConfig = setConfig('session');
export const setGlobalConfig = setConfig('global');
export const endSession = clearConfig('session');
export const resetGlobalConfig = clearConfig('global');
