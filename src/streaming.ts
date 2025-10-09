// @ts-ignore - ws module doesn't have proper types in this context
import WebSocket from 'ws';
import type { Hume } from 'hume';
import { debug } from './common';

// Resolves a promise with T, or null to indicate the stream ended.
type Resolver<T> = (value: T | null) => void;

class Queue<T> {
  private pushed: T[] = [];
  // If non-null, there is a consumer waiting for data, and
  // calling `waiting` with a chunk will resolve a promise that
  // sends the data to the consumer.
  private waiting: Resolver<T> | null = null;
  private ended = false;

  push(x: T) {
    if (this.ended) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(x);
    } else this.pushed.push(x);
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    if (this.waiting) {
      this.waiting(null);
      this.waiting = null;
    }
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.pushed.length) yield this.pushed.shift()!;
      else {
        const x = await new Promise<T | null>((r) => (this.waiting = r));
        if (x === null) break;
        yield x;
      }
    }
  }
}

export type PublishTts = {
  text?: string;
  voice?: Hume.tts.PostedUtteranceVoice;
  description?: string;
  speed?: number;
  trailingSilence?: number;
  flush?: boolean;
  close?: boolean;
};

export type StreamInputOptions = {
  apiKey: string;
  baseUrl?: string;
  instantMode?: boolean;
  formatType?: 'pcm' | 'wav' | 'mp3';
  stripHeaders?: boolean;
};

export class StreamingTtsClient {
  private constructor(
    private readonly ws: WebSocket,
    private readonly queue: Queue<Hume.tts.SnippetAudioChunk>
  ) {}

  static async connect(options: StreamInputOptions): Promise<StreamingTtsClient> {
    if (!options.apiKey) throw new Error('API key is required');

    const baseUrl = options.baseUrl ?? 'https://api.hume.ai';
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    
    const params = new URLSearchParams({
      api_key: options.apiKey,
      no_binary: 'true',
      instant_mode: String(options.instantMode ?? true),
      strip_headers: String(options.stripHeaders ?? true),
      format_type: options.formatType ?? 'pcm',
    });

    const url = `${wsUrl}/v0/tts/stream/input?${params.toString()}`;
    debug('Connecting to WebSocket: %s', url.replace(options.apiKey, '***'));

    const ws = new WebSocket(url);
    const queue = new Queue<Hume.tts.SnippetAudioChunk>();

    ws.onmessage = (event: any) => {
      try {
        const data = JSON.parse(event.data.toString());
        debug('Received message: %O', data);
        queue.push(data as Hume.tts.SnippetAudioChunk);
      } catch (error) {
        debug('Error parsing message: %O', error);
      }
    };
    ws.onclose = (event: any) => {
      debug('WebSocket closed: %d %s', event.code, event.reason);
      queue.end();
    };
    ws.onerror = (error: any) => {
      debug('WebSocket error: %O', error);
      queue.end();
    };

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        debug('WebSocket connected');
        resolve();
      };
      ws.onerror = (e: any) => {
        reject(new Error(`Failed to connect to WebSocket: ${e.message}`));
      };
    });

    return new StreamingTtsClient(ws, queue);
  }

  send(message: PublishTts) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected.');
    }
    debug('Sending message: %O', message);
    this.ws.send(JSON.stringify(message));
  }

  sendFlush() {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected.');
    }
    this.send({ flush: true });
  }

  sendClose() {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected.');
    }
    this.send({ close: true });
  }

  disconnect() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ close: true }));
    }
    this.ws.close();
  }

  async *[Symbol.asyncIterator]() {
    for await (const item of this.queue) {
      yield item;
    }
  }
}

