import { ApiKeyNotSetError, debug, getSettings, type CommonOpts } from './common';
import { withStdinAudioPlayer } from './play_audio';
import { spawn } from 'child_process';

export type ChatOpts = CommonOpts & {
  configId: string;
};

export class Evi {
  getSettings = getSettings;

  private ffmpegArgs(): string[] {
    if (process.platform === 'win32') {
      return ['-f', 'dshow', '-i', 'audio=default'];
    }
    if (process.platform === 'darwin') {
      return ['-f', 'avfoundation', '-i', ':0'];
    }
    return ['-f', 'alsa', '-i', 'default'];
  }

  async chat(opts: ChatOpts) {
    const { hume, reporter } = await this.getSettings(opts);
    if (!hume) {
      throw new ApiKeyNotSetError();
    }

    reporter.info('Connecting to EVI...');
    debug('Connecting with config %s', opts.configId);
    const socket = hume.empathicVoice.chat.connect({
      configId: opts.configId,
      debug: !!opts.debug,
    });

    await withStdinAudioPlayer(null, async (writeAudio) => {
      const rec = spawn('ffmpeg', [
        ...this.ffmpegArgs(),
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });

      socket.on('message', (message) => {
        debug('message: %s', message.type);
        if (message.type === 'audio_output') {
          const data = Buffer.from(message.data, 'base64');
          writeAudio(data);
        }
        if (message.type === 'assistant_message') {
          reporter.info(message.message.content || '');
        }
      });

      socket.on('open', () => {
        reporter.info('Connected');
        socket.sendSessionSettings({
          audio: { channels: 1, encoding: 'linear16', sampleRate: 16000 },
        });
      });

      socket.on('close', () => {
        reporter.info('Connection closed');
        rec.kill('SIGINT');
      });

      socket.on('error', (err) => {
        reporter.warn('Socket error: ' + err.message);
      });

      rec.stdout.on('data', (data: Buffer) => {
        socket.sendAudioInput({ data: data.toString('base64') });
      });

      process.on('SIGINT', () => {
        rec.kill('SIGINT');
        socket.close();
        process.exit();
      });

      await socket.tillSocketOpen();
      await new Promise((resolve) => socket.on('close', resolve));
    });
  }
}
