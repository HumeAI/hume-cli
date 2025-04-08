# Hume TTS CLI

This is a CLI for Hume AI's [Octave TTS](https://hume.ai/blog/octave-the-first-text-to-speech-model-that-understands-what-it-s-saying) API.

Unlike conventional TTS that merely "reads" words, Octave is a speech-language model that understands what words mean in context, unlocking a new level of expressiveness. It acts out characters, generates voices from prompts, and takes instructions to modify the emotion and style of a given utterance.

This CLI uses Hume's [Typescript SDK](https://github.com/humeai/hume-typescript-sdk) behind the scenes.

## Quickstart

```shell
npm install -g @humeai-cli
hume login
# Use the browser to login to platform.hume.ai to retrieve your
# API keys
hume tts "Are you serious?" --description "whispered, hushed"
hume voices create --name whisperer --last
hume tts "I said, are you serious?" --voice-name whisperer
hume voices list  # View your saved voices
hume voices list --provider HUME_AI  # View Hume's voice library
hume voices delete --name whisperer  # Delete a voice when no longer needed
```

## Installation

The Hume CLI is distributed [via NPM](https://www.npmjs.com/package/@humeai/cli). You can install it globally via:

```shell
npm install -g @humeai/cli
```

## Usage

Text to speech

━━━ Usage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

$ hume tts <text>

━━━ Options ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  -d,--description #0                         Description of the desired voice
  -c,--continue,--context-generation-id #0    Previous generation ID for continuation
  -l,--last,--continue-from-last              Use a generation from a previous synthesis as context. If the last synthesis was created with --num-generations > 1, you must also provide --last-index
  --last-index #0                             Index of the generation to use from the previous synthesis.
  -o,--output-dir #0                          Output directory for generated audio files
  -n,--num-generations #0                     Number of variations to generate
  -p,--prefix #0                              Filename prefix for generated audio
  --play #0                                   Play audio after generation: all variations, just the first, or none
  --play-command #0                           Command to play audio files (uses $AUDIO_FILE as placeholder for file path)
  --api-key #0                                Override the default API key
  --format #0                                 Output audio format
  -v,--voice-name #0                          Name of a previously saved voice
  --voice-id #0                               Direct voice ID to use
  --json                                      Output in JSON format
  --pretty                                    Output in human-readable format
  --base-url #0                               Override the default API base URL (for testing purposes)
  --provider #0                               Voice provider type (CUSTOM_VOICE or HUME_AI)
  --speed #0                                  Speaking speed multiplier (0.25-3.0, default is 1.0)
  --trailing-silence #0                       Seconds of silence to add at the end (0.0-5.0, default is 0.35)
  --streaming                                 Use streaming mode for TTS generation (default: true)

━━━ Details ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This command converts text to speech using Hume AI's advanced AI voice
synthesis. You can specify voice characteristics through descriptions or use
saved voices.

━━━ Examples ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Basic usage
  $ hume tts "Make sure to like and subscribe!" --description "The speaker is a charismatic, enthusiastic, male YouTuber in his 20s with a American accent, a slightly breathy voice, and a fast speaking rate."

Saving a voice you like (see `hume voices create --help`)
  $ hume voices create --name influencer_1 --last

Using a previously-saved voice
  $ hume tts "Thanks for the 100,000,000,000 likes guys!" -v influencer_1

Using a voice from the Hume Voice Library
  $ hume tts "Hello there" -v narrator --provider HUME_AI

Reading from stdin
  $ echo "I wouldn't be here without you" | hume tts - -v influencer_1

Continuing previous text
  $ hume tts "Take some arrows from the quiver" -v influencer_1
  $ hume tts "Take a bow, too" -v influencer_1 --last # should rhyme with 'toe' not 'cow'

Using custom audio player (macOS/Linux)
  $ hume tts "Hello world" -v narrator --play-command "mpv $AUDIO_FILE --no-video"

Using custom audio player (Windows)
  $ hume tts "Hello world" -v narrator --play-command "powershell -c \"[System.Media.SoundPlayer]::new('$AUDIO_FILE').PlaySync()\""

Setting a custom audio player for the session
  $ hume session set tts.playCommand "vlc $AUDIO_FILE --play-and-exit"

Adjusting speech speed
  $ hume tts "I am speaking very slowly" -v narrator --speed 0.75

Adding trailing silence
  $ hume tts "Wait for it..." -v narrator --trailing-silence 3.5

## Voice Management

The CLI provides commands to manage your custom voices:

### Creating Voices

Save a voice from a previous generation:

```shell
# Create a voice from the last generation
hume voices create --name my-narrator --last

# Create a voice from a specific generation ID
hume voices create --name my-narrator --generation-id abc123
````

### Listing Voices

List your custom voices:

```shell
# List your custom voices
hume voices list

# List voices from the Hume Voice Library
hume voices list --provider HUME_AI
```

### Deleting Voices

Delete a voice by name:

```shell
hume voices delete --name my-narrator
```

━━━ See also ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- `hume voices create --help` - Save a voice for later use
- `hume voices list --help` - List available voices
- `hume voices delete --help` - Delete a saved voice
- `hume session --help` - Save settings temporarily so you don't have to repeat yourself
- `hume config --help` - Save settings more permanently

```

```
