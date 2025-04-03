import {
  Cli,
  Command as ClipanionBaseCommand,
  Option,
  Builtins,
  type Usage,
  formatMarkdownish,
  type BaseContext,
} from 'clipanion';

import { CONFIG_FILE } from './config';

const usageDescriptions = {
  'tts.description': 'Description of the desired voice',
  'tts.voiceName': 'Name of a previously saved voice',
  'tts.voiceId': 'Direct voice ID to use',
  'tts.outputDir': 'Output directory for generated audio files',
  'tts.numGenerations': 'Number of variations to generate',
  'tts.prefix': 'Filename prefix for generated audio',
  'tts.play': 'Play audio after generation: all variations, just the first, or none',
  'tts.playCommand': 'Command to play audio files (uses $AUDIO_FILE as placeholder for file path)',
  'tts.format': 'Output audio format',
  'tts.provider': 'Voice provider type (CUSTOM_VOICE or HUME_AI)',
  'tts.speed': 'Speaking speed multiplier (0.25-3.0, default is 1.0)',
  'tts.trailingSilence': 'Seconds of silence to add at the end (0.0-5.0, default is 0.35)',
  'tts.streaming': 'Use streaming mode for TTS generation (default: true)',
  apiKey: 'Override the default API key',
  json: 'Output in JSON format',
  pretty: 'Output in human-readable format',
};
import { Tts } from './tts';
import * as t from 'typanion';
import { Voices } from './voices';
import {
  configValidators,
  endSession,
  resetGlobalConfig,
  setGlobalConfig,
  setSessionConfig,
  showGlobalConfig,
  showSession,
  login,
} from './config';

// Create and run the CLI
const cli = new Cli({
  binaryName: 'hume',
  binaryVersion: '0.1.0',
});

// Markdown helpers copy+pasted from `clipanion`  -- they were'n't exported.
const MAX_LINE_LENGTH = 80;
const richLine = Array(MAX_LINE_LENGTH).fill(`━`);
for (let t = 0; t <= 24; ++t) richLine[richLine.length - t] = `\x1b[38;5;${232 + t}m━`;
const richFormat = {
  header: (str: string) =>
    `\x1b[1m━━━ ${str}${str.length < MAX_LINE_LENGTH - 5 ? ` ${richLine.slice(str.length + 5).join(``)}` : `:`}\x1b[0m`,
  bold: (str: string) => `\x1b[1m${str}\x1b[22m`,
  error: (str: string) => `\x1b[31m\x1b[1m${str}\x1b[22m\x1b[39m`,
  code: (str: string) => `\x1b[36m${str}\x1b[39m`,
};

abstract class Command<
  Context extends BaseContext = BaseContext,
> extends ClipanionBaseCommand<Context> {
  async catch(e: unknown) {
    super.catch(e);
  }
}

class SessionRootCommand extends Command {
  static paths = [['session'], ['session', '--help'], ['session', '-h']];

  async execute() {
    this.context.stdout.write(this.cli.usage(SessionSetCommand, { detailed: true }));
    this.context.stdout.write(
      formatMarkdownish(
        `
    ${richFormat.header(`See also`)}
    
      * \`hume session show --help\` - Show current session settings
    
      * \`hume session end --help\` - End the current session
          `,
        { format: cli.format(), paragraphs: false }
      )
    );
  }
}

class SessionShowCommand extends Command {
  static paths = [['session', 'show']];
  static usage = Command.Usage({
    description: 'Show current session settings',
    details: 'Displays all settings that are active for the current session.',
    examples: [['View session settings', 'session info']],
  });

  async execute() {
    await showSession();
  }
}

class SessionEndCommand extends Command {
  static paths = [['session', 'end']];
  static usage = Command.Usage({
    description: 'End the current session',
    details: 'Clears all temporary session settings, reverting to global config defaults.',
    examples: [['End current session', 'session end']],
  });

  async execute() {
    await endSession();
  }
}

class SessionSetCommand extends Command {
  static paths = [['session', 'set']];
  static usage = Command.Usage({
    description: 'Configure session settings',
    details: `Sets temporary settings that apply only to the current session.
    
    Supported options:${[
      '',
      ...Object.keys(configValidators).map((x) => {
        const description = usageDescriptions[x as keyof typeof usageDescriptions];
        return `* \`${x}\` - ${description || 'No description available'}`;
      }),
    ].join('\n\n')}`,
    examples: [
      ['Set output directory for session', 'session set tts.outputDir ~/session-outputs'],
      ['Configure session autoplay', 'session set tts.play first'],
      ['Set voice name for session', 'session set tts.voiceName narrator'],
    ],
  });
  name = Option.String({
    required: true,
    validator: t.isEnum(Object.keys(configValidators) as Array<keyof typeof configValidators>),
  });
  value = Option.String({ required: true });
  async execute() {
    await setSessionConfig(this);
  }
}

class GlobalConfigRootCommand extends Command {
  static paths = [['config'], ['config', '--help'], ['config', '-h']];

  async execute() {
    this.context.stdout.write(this.cli.usage(GlobalConfigSetCommand, { detailed: true }));
    this.context.stdout.write(
      formatMarkdownish(
        `
    ${richFormat.header(`See also`)}
    
      * \`hume config show --help\` - List current global settings
    
      * \`hume config reset --help\` - Clear all global settings
    
      * \`hume session --help\` - Save settings temporarily
          `,
        { format: cli.format(), paragraphs: false }
      )
    );
  }
}

class GlobalConfigSetCommand extends Command {
  static paths = [['config', 'set']];
  static usage = Command.Usage({
    description: 'Configure global settings',
    details: `Persists settings to ${CONFIG_FILE} that apply to subsequent commands.
    
    Supported options:${[
      '',
      ...Object.keys(configValidators).map((x) => {
        const description = usageDescriptions[x as keyof typeof usageDescriptions];
        return `* \`${x}\` - ${description || 'No description available'}`;
      }),
    ].join('\n\n')}`,
    examples: [
      ['Set output directory', 'config set tts.outputDir ~/hume-tts-outputs'],
      ['Turn off autoplay', 'config set tts.play off'],
    ],
  });
  name = Option.String({
    required: true,
    validator: t.isEnum(Object.keys(configValidators) as Array<keyof typeof configValidators>),
  });
  value = Option.String({ required: true });

  async execute() {
    await setGlobalConfig(this);
  }
}

class GlobalConfigShowCommand extends Command {
  static paths = [['config', 'show']];

  async execute() {
    await showGlobalConfig();
  }
}

class GlobalConfigResetCommand extends Command {
  static paths = [['config', 'reset']];

  async execute() {
    await resetGlobalConfig();
  }
}

class SaveVoiceCommand extends Command {
  static paths = [['voices', 'create']];
  static usage = Command.Usage({
    description: 'Save a voice from a previous generation',
    details: 'Creates a reusable voice from a previous TTS generation or a specific generation ID.',
    examples: [
      ['Save the most recent generation', 'voices create --name my_voice --last'],
      ['Save a specific generation by ID', 'voices create --name narrator --generation-id abc123'],
    ],
  });

  name = Option.String('-n,--name', { required: true });
  generationId = Option.String({ required: false });
  last = Option.Boolean('-l,--last', {
    description: 'Use a generation from the previous synthesis',
  });
  lastIndex = Option.String('--last-index', {
    description: 'Index of the generation to use from the previous synthesis',
    validator: t.isNumber(),
  });
  apiKey = Option.String('--api-key');
  baseUrl = Option.String('--base-url', {
    description: 'Override the default API base URL (for testing purposes)',
  });
  json = Option.Boolean('--json', {
    description: usageDescriptions.json,
  });
  pretty = Option.Boolean('--pretty', {
    description: usageDescriptions.pretty,
  });

  async execute() {
    const voices = new Voices();
    await voices.save(this);
  }
}

class ListVoicesCommand extends Command {
  static paths = [['voices', 'list']];
  static usage = Command.Usage({
    description: 'List available voices',
    details: 'Lists your custom voices or the Hume Voice Library voices.',
    examples: [
      ['List your custom voices', 'voices list'],
      ['List voices from the Hume Voice Library', 'voices list --provider HUME_AI'],
    ],
  });

  provider = Option.String('--provider', {
    description: usageDescriptions['tts.provider'],
    validator: t.isEnum(['CUSTOM_VOICE', 'HUME_AI'] as const),
  });
  apiKey = Option.String('--api-key');
  baseUrl = Option.String('--base-url', {
    description: 'Override the default API base URL (for testing purposes)',
  });
  json = Option.Boolean('--json', {
    description: usageDescriptions.json,
  });
  pretty = Option.Boolean('--pretty', {
    description: usageDescriptions.pretty,
  });

  async execute() {
    const voices = new Voices();
    await voices.list(this);
  }
}

class DeleteVoiceCommand extends Command {
  static paths = [['voices', 'delete']];
  static usage = Command.Usage({
    description: 'Delete a saved voice',
    details: 'Permanently deletes a voice by name.',
    examples: [
      ['Delete a voice', 'voices delete --name my_voice'],
    ],
  });

  name = Option.String('-n,--name', { 
    required: true,
    description: 'Name of the voice to delete',
  });
  apiKey = Option.String('--api-key');
  baseUrl = Option.String('--base-url', {
    description: 'Override the default API base URL (for testing purposes)',
  });
  json = Option.Boolean('--json', {
    description: usageDescriptions.json,
  });
  pretty = Option.Boolean('--pretty', {
    description: usageDescriptions.pretty,
  });

  async execute() {
    const voices = new Voices();
    await voices.delete(this);
  }
}

const ttsExamples: Usage['examples'] = [
  [
    'Basic usage',
    '$0 tts \'Make sure to like and subscribe!\' --description "The speaker is a charismatic, enthusiastic, male YouTuber in his 20s with a American accent, a slightly breathy voice, and a fast speaking rate."',
  ],
  [
    'Saving a voice you like (see `hume voices create --help`)',
    '$0 voices create --name influencer_1 --last',
  ],
  [
    'Using a previously-saved voice',
    "$0 tts 'Thanks for the 100,000,000,000 likes guys!' -v influencer_1",
  ],
  ['Reading from stdin', 'echo "I wouldn\'t be here without you" | $0 tts - -v influencer_1'],
  [
    'Continuing previous text',
    `$0 tts "Take some arrows from the quiver" -v influencer_1\n  ${richFormat.bold('$')} hume tts "Take a bow, too" -v influencer_1 --last # should rhyme with 'toe' not 'cow'`,
  ],
  [
    'Using custom audio player (macOS/Linux)',
    '$0 tts "Hello world" -v narrator --play-command "mpv $AUDIO_FILE --no-video"',
  ],
  [
    'Using custom audio player (Windows)',
    '$0 tts "Hello world" -v narrator --play-command "powershell -c \\"[System.Media.SoundPlayer]::new(\'$AUDIO_FILE\').PlaySync()\\"" ',
  ],
  [
    'Setting a custom audio player for the session',
    'hume session set tts.playCommand "vlc $AUDIO_FILE --play-and-exit"',
  ],
  ['Adjusting speech speed', '$0 tts "I am speaking very slowly" -v narrator --speed 0.75'],
  ['Adding trailing silence', '$0 tts "Wait for it..." -v narrator --trailing-silence 3.5'],
];
class TtsCommand extends Command {
  static paths = [['tts']];
  
  // Define custom usage with overridden usage line to control what options are shown in the summary
  static usage = Object.assign(Command.Usage({
    description: 'Text to speech',
    details: `
      This command converts text to speech using Hume AI's advanced AI voice synthesis.
      You can specify voice characteristics through descriptions or use saved voices.
    `,
    examples: ttsExamples,
  }), {
    usage: `$ hume tts <text>`,
  });

  text = Option.String({ required: true, name: 'text' });
  description = Option.String('-d,--description', {
    description: usageDescriptions['tts.description'],
  });
  last = Option.Boolean('-l,--last,--continue-from-last', {
    description:
      'Continue from a generation from the last synthesis. If the last synthesis was created with --num-generations > 1, you must also provide --last-index',
  });
  lastIndex = Option.String('--last-index', {
    description: 'Index of the generation to use from the previous synthesis.',
    validator: t.isNumber(),
  });
  contextGenerationId = Option.String('-c,--continue,--context-generation-id', {
    description: 'Continue from a specific generation with the specified ID',
  });
  numGenerations = Option.String('-n,--num-generations', {
    validator: t.isNumber(),
    description: usageDescriptions['tts.numGenerations'],
  });
  outputDir = Option.String('-o,--output-dir', {
    description: usageDescriptions['tts.outputDir'],
  });
  prefix = Option.String('-p,--prefix', {
    description: usageDescriptions['tts.prefix'],
  });
  play = Option.String('--play', {
    validator: t.isEnum(['all', 'first', 'off'] as const),
    description: usageDescriptions['tts.play'],
  });
  playCommand = Option.String('--play-command', {
    description: usageDescriptions['tts.playCommand'],
  });
  apiKey = Option.String('--api-key', {
    description: usageDescriptions.apiKey,
  });
  format = Option.String('--format', {
    validator: t.isEnum(['wav', 'mp3', 'pcm'] as const),
    description: usageDescriptions['tts.format'],
  });
  voiceName = Option.String('-v,--voice-name', {
    description: usageDescriptions['tts.voiceName'],
  });
  voiceId = Option.String('--voice-id', {
    description: usageDescriptions['tts.voiceId'],
  });
  json = Option.Boolean('--json', {
    description: usageDescriptions.json,
  });

  pretty = Option.Boolean('--pretty', {
    description: usageDescriptions.pretty,
  });

  baseUrl = Option.String('--base-url', {
    description: 'Override the default API base URL (for testing purposes)',
  });

  // Hidden legacy option that still works but isn't mentioned in help
  presetVoice = Option.Boolean('--preset-voice', { hidden: true });
  
  provider = Option.String('--provider', {
    description: usageDescriptions['tts.provider'],
    validator: t.isEnum(['CUSTOM_VOICE', 'HUME_AI'] as const),
  });

  speed = Option.String('--speed', {
    validator: t.cascade(t.isNumber(), t.isInInclusiveRange(0.25, 3.0)),
    description: usageDescriptions['tts.speed'],
  });

  trailingSilence = Option.String('--trailing-silence', {
    validator: t.cascade(t.isNumber(), t.isInInclusiveRange(0.0, 5.0)),
    description: usageDescriptions['tts.trailingSilence'],
  });

  streaming = Option.Boolean('--streaming', {
    description: usageDescriptions['tts.streaming'],
  });

  async execute() {
    const tts = new Tts();
    await tts.synthesize(this);
  }
}

// Root command that shows help by default
class RootCommand extends Command {
  static paths = [Command.Default];
  async execute() {
    this.context.stdout.write(this.cli.usage(TtsCommand, { detailed: true }));
  }
}

class HelpCommand extends Builtins.HelpCommand {
  async execute() {
    this.context.stdout.write(this.cli.usage(TtsCommand, { detailed: true }));
    this.context.stdout.write('\n');
    this.context.stdout.write(
      formatMarkdownish(
        `
    ${richFormat.header(`See also`)}
    
      * \`hume voices create --help\` - Save a voice for later use
      
      * \`hume voices list --help\` - List available voices
      
      * \`hume voices delete --help\` - Delete a saved voice
    
      * \`hume session --help\` - Save settings temporarily so you don't have to repeat yourself
    
      * \`hume config --help\` - Save settings more permanently
          `,
        { format: cli.format(), paragraphs: false }
      )
    );
  }
}

class LoginCommand extends Command {
  static paths = [['login']];
  static usage = Command.Usage({
    description: 'Login to Hume',
    details: 'Saves your API key for future use',
    examples: [['Login to Hume', 'login']],
  });

  async execute() {
    await login();
  }
}

cli.register(RootCommand);
cli.register(TtsCommand);
cli.register(LoginCommand);
cli.register(SessionRootCommand);
cli.register(SaveVoiceCommand);
cli.register(ListVoicesCommand);
cli.register(DeleteVoiceCommand);
cli.register(SessionSetCommand);
cli.register(SessionShowCommand);
cli.register(SessionEndCommand);
cli.register(GlobalConfigSetCommand);
cli.register(GlobalConfigShowCommand);
cli.register(GlobalConfigResetCommand);
cli.register(GlobalConfigRootCommand);
cli.register(HelpCommand);

try {
  cli.process(process.argv.slice(2));
} catch (e_) {
  const e = e_ as any;
  if (e.name === 'UnknownSyntaxError') {
    const possibleCommands = cli.definitions().filter((d) => {
      return e.candidates[0].usage.startsWith(d.path);
    });
    possibleCommands.sort((a, b) => b.path.split(' ').length - a.path.split(' ').length);
    const cmd = possibleCommands[0];
    if (!cmd) {
      console.error(e);
    } else {
      console.error(`Error: ${e.candidates[0].reason}\n\n${cmd.usage}\n\n${cmd.details}`);
    }
    process.exit(1);
  }
  throw e;
}
await cli.runExit(process.argv.slice(2));
