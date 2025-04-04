import type { ReturnVoice } from 'hume/api/resources/tts';
import { debug, ApiKeyNotSetError, getSettings, type CommonOpts } from './common';
import { getLastSynthesisFromHistory } from './history';

/** Represents the raw options passed from the command line for saving a voice */
type RawSaveVoiceOpts = CommonOpts & {
  apiKey?: string;
  name: string;
  generationId?: string;
  last?: boolean;
  lastIndex?: number;
};

/** Represents the raw options passed from the command line for listing voices */
type RawListVoicesOpts = CommonOpts & {
  provider?: 'CUSTOM_VOICE' | 'HUME_AI';
  pageSize?: number;
  pageNumber?: number;
};

/** Represents the raw options passed from the command line for deleting a voice */
type RawDeleteVoiceOpts = CommonOpts & {
  name: string;
};

export class Voices {
  getSettings = getSettings;
  getLastSynthesis = getLastSynthesisFromHistory;

  /**
   * Save a voice from a generation
   */
  public save = async (opts: RawSaveVoiceOpts) => {
    const { reporter, hume } = await this.getSettings(opts);
    if (!hume) {
      throw new ApiKeyNotSetError();
    }

    let generationId = opts.generationId;

    if (opts.last) {
      const lastGeneration = await this.getLastSynthesis();

      if (!lastGeneration) {
        throw new Error('No previous generation found to save as voice');
      }

      const nLastGenerations = lastGeneration.ids.length;
      if (nLastGenerations > 1 && opts.lastIndex === undefined) {
        throw new Error(
          `Previous synthesis contained ${nLastGenerations} generations. Please specify --last-index between 1 and ${lastGeneration.ids.length}`
        );
      }

      if (
        opts.lastIndex !== undefined &&
        (opts.lastIndex < 1 || opts.lastIndex > nLastGenerations)
      ) {
        throw new Error(`Please specify --last-index between 1 and ${lastGeneration.ids.length}`);
      }

      generationId = lastGeneration.ids[(opts.lastIndex ?? 1) - 1];
    }

    if (!generationId) {
      throw new Error('Must specify either --generation-id or --last');
    }

    const body = {
      name: opts.name,
      generationId,
    };
    debug('Save voice request: %O', body);
    const result = await reporter.withSpinner('Saving voice...', async () => {
      return await hume.tts.voices.create(body);
    });
    reporter.info('Voice name: ' + result.name);
    reporter.info(
      `Test your voice on the web at https://api.hume.ai/tts/playground?voiceId=${result.id}`
    );
    reporter.json(result);
  };

  /**
   * List voices with optional provider filter
   * Default provider is CUSTOM_VOICE (user-created voices)
   */
  public list = async (opts: RawListVoicesOpts) => {
    const {pageSize, pageNumber} = opts;
    const { reporter, hume } = await this.getSettings(opts);
    if (!hume) {
      throw new ApiKeyNotSetError();
    }

    // Default to CUSTOM_VOICE (user's saved voices) if not specified
    const provider = opts.provider || 'CUSTOM_VOICE';

    debug('List voices request with provider: %s', provider);
    const result = await reporter.withSpinner(
      `Listing ${provider === 'HUME_AI' ? 'Hume Voice Library' : 'your custom'} voices...`,
      async () => {
        return await hume.tts.voices.list({ provider, pageSize, pageNumber});
      }
    );


    reporter.json(result.data.map((voice: ReturnVoice) => ({
      id: voice.id,
      name: voice.name,
    })));
    for (const voice of result.data) {
      reporter.info(`${voice.name} (${voice.id})`);
    }

    if (result.hasNextPage()) {
      reporter.info(`There are more voices available. Use --page-number ${(pageNumber ?? 0) + 1} to retrieve them.`)
    }
  };

  /**
   * Delete a voice by name
   */
  public delete = async (opts: RawDeleteVoiceOpts) => {
    const { reporter, hume } = await this.getSettings(opts);
    if (!hume) {
      throw new ApiKeyNotSetError();
    }

    debug('Delete voice request for name: %s', opts.name);
    const result = await reporter.withSpinner(`Deleting voice "${opts.name}"...`, async () => {
      return await hume.tts.voices.delete({ name: opts.name });
    });

    reporter.info(`Voice "${opts.name}" deleted successfully`);
    reporter.json(result);
  };
}
