import { Edge, findPipeline, StreamType, TransformerType } from './TransformerGraph';
import { once, pipeline, Readable } from 'stream';
import { noop } from '../util/util';
import { VolumeTransformer, opus, FFmpeg } from 'prism-media';
import { AudioPlayer, SILENCE_FRAME } from './AudioPlayer';

/**
 * Options that are set when creating a new audio resource.
 *
 * @template T - the type for the metadata (if any) of the audio resource.
 */
interface CreateAudioResourceOptions<T> {
	/**
	 * The type of the input stream. Defaults to `StreamType.Arbitrary`.
	 */
	inputType?: StreamType;

	/**
	 * Optional metadata that can be attached to the resource (e.g. track title, random ID).
	 * This is useful for identification purposes when the resource is passed around in events.
	 * See {@link AudioResource.metadata}
	 */
	metadata?: T;

	/**
	 * Whether or not inline volume should be enabled. If enabled, you will be able to change the volume
	 * of the stream on-the-fly. However, this also increases the performance cost of playback. Defaults to `false`.
	 */
	inlineVolume?: boolean;

	/**
	 * The number of silence frames to append to the end of the resource's audio stream, to prevent interpolation glitches.
	 * Defaults to 5.
	 */
	silencePaddingFrames?: number;
}

interface CreateFFMPEGResourceOptions {
	/**
	 * Arguments to be used before '-i' argument in FFMPEG.
	 */
	arguments?: string[];
	/** *
	 * Adds reconnect arguments if set to true
	 */
	reconnect?: boolean;
	/**
	 * Sets reconnection time if reconnect is set to true. Default is 5 sec (5000 ms)
	 */
	reconnect_time?: number;
	/**
	 * Time to seek in audio resource (in ms)
	 */
	seek?: number;
	/**
	 * Whether or not inline volume should be enabled. If enabled, you will be able to change the volume
	 * of the stream on-the-fly. However, this also increases the performance cost of playback. Defaults to `false`.
	 */
	inlineVolume?: boolean;
}

/**
 * Represents an audio resource that can be played by an audio player.
 *
 * @template T - the type for the metadata (if any) of the audio resource.
 */
export class AudioResource<T = unknown> {
	/**
	 * An object-mode Readable stream that emits Opus packets. This is what is played by audio players.
	 */
	public readonly playStream: Readable;

	/**
	 * The pipeline used to convert the input stream into a playable format. For example, this may
	 * contain an FFmpeg component for arbitrary inputs, and it may contain a VolumeTransformer component
	 * for resources with inline volume transformation enabled.
	 */
	public readonly edges: readonly Edge[];

	/**
	 * Optional metadata that can be used to identify the resource.
	 */
	public metadata: T;

	/**
	 * If the resource was created with inline volume transformation enabled, then this will be a
	 * prism-media VolumeTransformer. You can use this to alter the volume of the stream.
	 */
	public readonly volume?: VolumeTransformer;

	/**
	 * If using an Opus encoder to create this audio resource, then this will be a prism-media opus.Encoder.
	 * You can use this to control settings such as bitrate, FEC, PLP.
	 */
	public readonly encoder?: opus.Encoder;

	/**
	 * The audio player that the resource is subscribed to, if any.
	 */
	public audioPlayer?: AudioPlayer;

	/**
	 * The playback duration of this audio resource, given in milliseconds.
	 */
	public playbackDuration = 0;

	/**
	 * Whether or not the stream for this resource has started (data has become readable)
	 */
	public started = false;

	/**
	 * The number of silence frames to append to the end of the resource's audio stream, to prevent interpolation glitches.
	 */
	public readonly silencePaddingFrames: number;

	/**
	 * The number of remaining silence frames to play. If -1, the frames have not yet started playing.
	 */
	public silenceRemaining = -1;

	public constructor(edges: readonly Edge[], streams: readonly Readable[], metadata: T, silencePaddingFrames: number) {
		this.edges = edges;
		this.playStream = streams.length > 1 ? (pipeline(streams, noop) as any as Readable) : streams[0];
		this.metadata = metadata;
		this.silencePaddingFrames = silencePaddingFrames;

		for (const stream of streams) {
			if (stream instanceof VolumeTransformer) {
				this.volume = stream;
			} else if (stream instanceof opus.Encoder) {
				this.encoder = stream;
			}
		}

		once(this.playStream, 'readable')
			.then(() => (this.started = true))
			.catch(noop);
	}

	/**
	 * Whether this resource is readable. If the underlying resource is no longer readable, this will still return true
	 * while there are silence padding frames left to play.
	 */
	public get readable() {
		if (this.silenceRemaining === 0) return false;
		const real = this.playStream.readable;
		if (!real) {
			if (this.silenceRemaining === -1) this.silenceRemaining = this.silencePaddingFrames;
			return this.silenceRemaining !== 0;
		}
		return real;
	}

	/**
	 * Whether this resource has ended or not.
	 */
	public get ended() {
		return this.playStream.readableEnded || this.playStream.destroyed || this.silenceRemaining === 0;
	}

	/**
	 * Attempts to read an Opus packet from the audio resource. If a packet is available, the playbackDuration
	 * is incremented.
	 * @internal
	 * @remarks
	 * It is advisable to check that the playStream is readable before calling this method. While no runtime
	 * errors will be thrown, you should check that the resource is still available before attempting to
	 * read from it.
	 */
	public read(): Buffer | null {
		if (this.silenceRemaining === 0) {
			return null;
		} else if (this.silenceRemaining > 0) {
			this.silenceRemaining--;
			return SILENCE_FRAME;
		}
		const packet: Buffer | null = this.playStream.read();
		if (packet) {
			this.playbackDuration += 20;
		}
		return packet;
	}
}

/**
 * Ensures that a path contains at least one volume transforming component
 *
 * @param path - The path to validate constraints on
 */
export const VOLUME_CONSTRAINT = (path: Edge[]) => path.some((edge) => edge.type === TransformerType.InlineVolume);

export const NO_CONSTRAINT = () => true;

/**
 * Tries to infer the type of a stream to aid with transcoder pipelining.
 *
 * @param stream - The stream to infer the type of
 */
export function inferStreamType(stream: Readable): {
	streamType: StreamType;
	hasVolume: boolean;
} {
	if (stream instanceof opus.Encoder) {
		return { streamType: StreamType.Opus, hasVolume: false };
	} else if (stream instanceof opus.Decoder) {
		return { streamType: StreamType.Raw, hasVolume: false };
	} else if (stream instanceof VolumeTransformer) {
		return { streamType: StreamType.Raw, hasVolume: true };
	} else if (stream instanceof opus.OggDemuxer) {
		return { streamType: StreamType.Opus, hasVolume: false };
	} else if (stream instanceof opus.WebmDemuxer) {
		return { streamType: StreamType.Opus, hasVolume: false };
	}
	return { streamType: StreamType.Arbitrary, hasVolume: false };
}

export function createAudioResource<T>(
	input: string | Readable,
	options: CreateAudioResourceOptions<T> &
		Pick<
			T extends null | undefined ? CreateAudioResourceOptions<T> : Required<CreateAudioResourceOptions<T>>,
			'metadata'
		>,
): AudioResource<T extends null | undefined ? null : T>;

export function createAudioResource<T extends null | undefined>(
	input: string | Readable,
	options?: Omit<CreateAudioResourceOptions<T>, 'metadata'>,
): AudioResource<null>;

/**
 * Creates an audio resource that can be played be audio players.
 *
 * @remarks
 * If the input is given as a string, then the inputType option will be overridden and FFmpeg will be used.
 *
 * If the input is not in the correct format, then a pipeline of transcoders and transformers will be created
 * to ensure that the resultant stream is in the correct format for playback. This could involve using FFmpeg,
 * Opus transcoders, and Ogg/WebM demuxers.
 *
 * @param input - The resource to play.
 * @param options - Configurable options for creating the resource.
 *
 * @template T - the type for the metadata (if any) of the audio resource.
 */
export function createAudioResource<T>(
	input: string | Readable,
	options: CreateAudioResourceOptions<T> = {},
): AudioResource<T> {
	let inputType = options.inputType;
	let needsInlineVolume = Boolean(options.inlineVolume);

	// string inputs can only be used with FFmpeg
	if (typeof input === 'string') {
		inputType = StreamType.Arbitrary;
	} else if (typeof inputType === 'undefined') {
		const analysis = inferStreamType(input);
		inputType = analysis.streamType;
		needsInlineVolume = needsInlineVolume && !analysis.hasVolume;
	}

	const transformerPipeline = findPipeline(inputType, needsInlineVolume ? VOLUME_CONSTRAINT : NO_CONSTRAINT);

	if (transformerPipeline.length === 0) {
		if (typeof input === 'string') throw new Error(`Invalid pipeline constructed for string resource '${input}'`);
		// No adjustments required
		return new AudioResource<T>([], [input], (options.metadata ?? null) as T, options.silencePaddingFrames ?? 5);
	}
	const streams = transformerPipeline.map((edge) => edge.transformer(input));
	if (typeof input !== 'string') streams.unshift(input);

	return new AudioResource<T>(
		transformerPipeline,
		streams,
		(options.metadata ?? null) as T,
		options.silencePaddingFrames ?? 5,
	);
}

export function createFFMPEGResource<T>(
	input: string,
	options?: CreateFFMPEGResourceOptions,
): AudioResource<T extends null | undefined ? null : T>;

export function createFFMPEGResource(input: string, options: CreateFFMPEGResourceOptions = {}): AudioResource | void {
	const final_args: string[] = [];
	const FFMPEG_OPUS_ARGUMENTS = [
		'-analyzeduration',
		'0',
		'-loglevel',
		'0',
		'-acodec',
		'libopus',
		'-f',
		'opus',
		'-ar',
		'48000',
		'-ac',
		'2',
	];
	const FFMPEG_PCM_ARGUMENTS = [
		'-analyzeduration',
		'0',
		'-loglevel',
		'0',
		'-f',
		's16le',
		'-acodec',
		'pcm_s16le',
		'-ar',
		'48000',
		'-ac',
		'2',
	];

	if (typeof input !== 'string') {
		console.error('Input is not a string');
		return;
	}
	if (options.arguments && options.arguments.length !== 0) {
		options.arguments.forEach((x) => {
			final_args.push(x);
		});
	}
	if (options.seek) {
		final_args.push('-ss', `${options.seek}`, '-accurate_seek');
	}
	if (options.reconnect === true) {
		if (options.reconnect_time)
			final_args.push(
				'-reconnect',
				'1',
				'-reconnect_streamed',
				'1',
				'-reconnect_delay_max',
				`${options.reconnect_time}`,
			);
		else final_args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
	}
	final_args.push('-i', input);
	options.inlineVolume ? final_args.push(...FFMPEG_PCM_ARGUMENTS) : final_args.push(...FFMPEG_OPUS_ARGUMENTS);
	const ffmpeg_instance = new FFmpeg({
		args: final_args,
	});
	return createAudioResource(ffmpeg_instance, {
		inputType: StreamType.OggOpus,
		inlineVolume: options.inlineVolume ? options.inlineVolume : false,
	});
}
