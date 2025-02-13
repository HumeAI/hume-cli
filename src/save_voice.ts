import { debug, ApiKeyNotSetError, getSettings, type CommonOpts } from './common';
import { getLastSynthesisFromHistory } from './history';

/** Represents the raw options passed from the command line */
type RawSaveVoiceOpts = CommonOpts & {
  apiKey?: string;
  name: string;
  generationId?: string;
  last?: boolean;
  lastIndex?: number;
};

export class Voice {
  getSettings = getSettings;
  getLastSynthesis = getLastSynthesisFromHistory;
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
}
