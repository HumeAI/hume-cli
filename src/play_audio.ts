import { debug } from './common';
import { spawnSync, spawn } from 'child_process';

type Command = {
  cmd: string;
  argsWithPath: (path: string) => string[];
  argsWithStdin: string[] | null;
};

let defaultAudioPlayer: Command | null | undefined = undefined;
const findDefaultAudioPlayer = (): Command | null => {
  if (defaultAudioPlayer === undefined) {
    defaultAudioPlayer = findDefaultAudioPlayer_();
  }
  return defaultAudioPlayer;
};
const findDefaultAudioPlayer_ = (): Command | null => {
  const isWindows = process.platform === 'win32';

  const atEnd =
    (...arr: string[]) =>
    (path: string) => [...arr, path];

  // Ordered by preference
  const commonPlayers: Command[] = isWindows
    ? [
        {
          cmd: 'powershell',
          argsWithPath: (path) => ['-c', `"(New-Object Media.SoundPlayer '${path}').PlaySync()"`],
          argsWithStdin: null,
        },
        {
          cmd: 'ffplay',
          argsWithPath: atEnd('-nodisp', '-autoexit'),
          argsWithStdin: ['-nodisp', '-autoexit', '-i', '-'],
        },
        { cmd: 'mpv', argsWithPath: atEnd('--no-video'), argsWithStdin: ['--no-video', '-'] },
        { cmd: 'mplayer', argsWithPath: atEnd(''), argsWithStdin: ['-'] },
      ]
    : [
        {
          cmd: 'ffplay',
          argsWithPath: atEnd('-nodisp', '-autoexit'),
          argsWithStdin: ['-nodisp', '-autoexit', '-i', '-'],
        },
        { cmd: 'afplay', argsWithPath: atEnd(''), argsWithStdin: null },
        { cmd: 'mplayer', argsWithPath: atEnd(''), argsWithStdin: ['-'] },
        { cmd: 'mpv', argsWithPath: atEnd('--no-video'), argsWithStdin: ['--no-video', '-'] },
        { cmd: 'aplay', argsWithPath: atEnd(''), argsWithStdin: ['-'] },
        { cmd: 'play', argsWithPath: atEnd(''), argsWithStdin: ['-'] },
      ];

  for (const player of commonPlayers) {
    const checkCmd = isWindows ? 'where' : 'which';
    try {
      spawnSync(checkCmd, [player.cmd]);
      return player; // found!
    } catch {}
  }

  return null;
};

export const playAudioFile = async (path: string, customCommand: string | null) => {
  const command = ensureAudioPlayer(
    customCommand ? parseCustomCommand(customCommand) : findDefaultAudioPlayer()
  );
  const isWindows = process.platform === 'win32';
  const sanitizedPath = isWindows ? path.replace(/\\/g, '\\\\') : path;

  return new Promise<void>((resolve, reject) => {
    const process = spawn(command.cmd, [...command.argsWithPath(sanitizedPath)], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    process.on('close', (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    process.on('error', (err: any) => {
      reject(err);
    });
  });
};

export const parseCustomCommand = (command: string): Command => {
  const [cmd, ...args] = command.split(' ');
  const argsWithPath = (path: string) => args.map((arg) => arg.replace('$AUDIO_FILE', path));
  const argsWithStdin = args.some((arg) => arg.includes('$AUDIO_FILE')) ? argsWithPath('-') : args;

  return {
    cmd,
    argsWithPath,
    argsWithStdin,
  };
};

const ensureAudioPlayer = (command: Command | null): Command => {
  if (!command) {
    throw new Error(
      'No audio player found. Please install ffplay or specify a custom player with --play-command'
    );
  }
  return command;
};

const ensureStdinSupport = (command: Command): Command & { argsWithStdin: string[] } => {
  const { argsWithStdin } = command;
  if (!argsWithStdin) {
    throw new Error(
      `The audio player does not support playing from stdin. Please specify a custom player with --play-command`
    );
  }
  return { ...command, argsWithStdin };
};

export const withStdinAudioPlayer = async (
  customCommand: string | null,
  f: (writeAudio: (audioBuffer: Buffer) => void) => Promise<void>
): Promise<void> => {
  const command = ensureStdinSupport(
    ensureAudioPlayer(customCommand ? parseCustomCommand(customCommand) : findDefaultAudioPlayer())
  );
  debug([command.cmd, command.argsWithStdin]);

  const { spawn } = require('child_process');
  const proc = spawn(command.cmd, [...command.argsWithStdin], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  await f((audioBuffer) => {
    proc.stdin.write(audioBuffer);
  });

  proc.stdin.end();

  return new Promise((resolve, reject) => {
    proc.on('close', (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    proc.on('error', (err: any) => {
      reject(err);
    });
  });
};
