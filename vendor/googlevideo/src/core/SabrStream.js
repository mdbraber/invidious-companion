import { FormatInitializationMetadata, MediaHeader, NextRequestPolicy, PlaybackCookie, ReloadPlaybackContext, SabrContextSendingPolicy, SabrContextUpdate, SabrContextWritePolicy, SabrError, SabrRedirect, StreamProtectionStatus, VideoPlaybackAbrRequest, UMPPartId } from '../utils/Protos.js';
import { MAX_INT32_VALUE, EnabledTrackTypes, base64ToU8, concatenateChunks, EventEmitterLike, Logger, wait } from '../utils/index.js';
import * as FormatKeyUtils from '../utils/formatKeyUtils.js';
import { chooseFormat, getMediaType, getTotalDownloadedDuration } from '../utils/sabrStreamUtils.js';
import { CompositeBuffer } from './CompositeBuffer.js';
import { UmpReader } from './UmpReader.js';
const TAG = 'SabrStream';
const DEFAULT_MAX_RETRIES = 10;
const MAX_BACKOFF_MS = 8000;
const BACKOFF_MULTIPLIER = 500;
const DEFAULT_STALL_DETECTION_MS = 30000;
const MAX_STALLS = 5;
/**
 * Manages the download and processing of YouTube's Server-Adaptive Bitrate (SABR) streams.
 *
 * This class handles the entire lifecycle of a SABR stream:
 * - Selecting appropriate video and audio formats.
 * - Making network requests to fetch media segments.
 * - Processing UMP parts in real-time.
 * - Handling server-side directives like redirects, context updates, and backoff policies.
 * - Emitting events for key stream updates, such as format initialization and errors.
 * - Providing separate `ReadableStream` instances for video and audio data.
 */
export class SabrStream extends EventEmitterLike {
    on(event, listener) {
        super.on(event, listener);
    }
    once(event, listener) {
        super.once(event, listener);
    }
    constructor(config = {}) {
        super();
        this.logger = Logger.getInstance();
        this.formatIds = [];
        this.umpPartHandlers = new Map([
            [UMPPartId.FORMAT_INITIALIZATION_METADATA, this.handleFormatInitializationMetadata.bind(this)],
            [UMPPartId.NEXT_REQUEST_POLICY, this.handleNextRequestPolicy.bind(this)],
            [UMPPartId.SABR_ERROR, this.handleSabrError.bind(this)],
            [UMPPartId.SABR_REDIRECT, this.handleSabrRedirect.bind(this)],
            [UMPPartId.SABR_CONTEXT_UPDATE, this.handleSabrContextUpdate.bind(this)],
            [UMPPartId.SABR_CONTEXT_SENDING_POLICY, this.handleSabrContextSendingPolicy.bind(this)],
            [UMPPartId.STREAM_PROTECTION_STATUS, this.handleStreamProtectionStatus.bind(this)],
            [UMPPartId.RELOAD_PLAYER_RESPONSE, this.handleReloadPlayerResponse.bind(this)],
            [UMPPartId.MEDIA_HEADER, this.handleMediaHeader.bind(this)],
            [UMPPartId.MEDIA, this.handleMedia.bind(this)],
            [UMPPartId.MEDIA_END, this.handleMediaEnd.bind(this)]
        ]);
        this.sabrContexts = new Map();
        this.activeSabrContextTypes = new Set();
        this.initializedFormatsMap = new Map();
        this.partialSegmentQueue = new Map();
        this.requestNumber = 0;
        this.durationMs = Infinity;
        /**
         * Synthetic ranges covering content `startAtMs` skipped past. They are not
         * consumed from the server, so no format owns them, but they must be quoted
         * on every request or the server has no reason to start where we asked.
         */
        this.seededBufferedRanges = [];
        this.mediaHeadersProcessed = false;
        this._errored = false;
        this._aborted = false;
        this.progressTracker = {
            lastProgressTime: Date.now(),
            lastDownloadedDuration: 0,
            stallCount: 0
        };
        this.fetchFunction = config?.fetch || fetch;
        this.serverAbrStreamingUrl = config.serverAbrStreamingUrl;
        this.videoPlaybackUstreamerConfig = config.videoPlaybackUstreamerConfig;
        this.clientInfo = config.clientInfo;
        this.poToken = config.poToken;
        this.durationMs = config.durationMs || Infinity;
        this.formatIds = config.formats || [];
        this.videoStream = new ReadableStream({
            start: (controller) => {
                this.videoController = controller;
            }
        });
        this.audioStream = new ReadableStream({
            start: (controller) => {
                this.audioController = controller;
            }
        });
    }
    /**
     * Sets Proof of Origin (PO) token.
     * @param poToken - The base64-encoded token string.
     */
    setPoToken(poToken) {
        this.poToken = poToken;
    }
    /**
     * Sets the available server ABR formats.
     * @param formats - An array of available SabrFormat objects.
     */
    setServerAbrFormats(formats) {
        this.formatIds.push(...formats);
    }
    /**
     * Sets the total duration of the stream in milliseconds.
     * This is optional as duration is often determined automatically from format metadata.
     * @param durationMs - The duration in milliseconds.
     */
    setDurationMs(durationMs) {
        this.durationMs = durationMs;
    }
    /**
     * Sets the server ABR streaming URL for media requests.
     * @param url - The streaming URL.
     */
    setStreamingURL(url) {
        this.serverAbrStreamingUrl = url;
    }
    /**
     * Sets the Ustreamer configuration string.
     * @param config - The Ustreamer configuration.
     */
    setUstreamerConfig(config) {
        this.videoPlaybackUstreamerConfig = config;
    }
    /**
     * Sets the client information used in SABR requests.
     * @param clientInfo - The client information object.
     */
    setClientInfo(clientInfo) {
        this.clientInfo = clientInfo;
    }
    /**
     * Aborts the download process, closing all streams and cleaning up resources.
     * Emits an 'abort' event.
     */
    abort() {
        this.logger.debug(TAG, 'Aborting download process');
        this._aborted = true;
        this.abortController?.abort();
        this.videoController?.error(new Error('Download aborted.'));
        this.audioController?.error(new Error('Download aborted.'));
        this.resetState();
        this.emit('abort');
    }
    //#region --- Stream Initialization and Lifecycle Control ---
    /**
     * Returns a serializable state object that can be used to restore the stream later.
     * @throws {Error} If the main format is not initialized.
     * @returns The current state of the stream.
     */
    getState() {
        if (!this.mainFormat)
            throw new Error('Main format is not initialized, cannot get state.');
        const playerTimeMs = getTotalDownloadedDuration(this.mainFormat);
        const initializedFormats = [];
        for (const [formatKey, format] of this.initializedFormatsMap.entries()) {
            initializedFormats.push({
                formatKey,
                formatInitializationMetadata: format.formatInitializationMetadata,
                downloadedSegments: Array.from(format.downloadedSegments.entries()),
                lastMediaHeaders: format.lastMediaHeaders,
                consumedRanges: format.consumedRanges
            });
        }
        return {
            durationMs: this.durationMs,
            requestNumber: this.requestNumber,
            activeSabrContexts: Array.from(this.activeSabrContextTypes),
            sabrContextUpdates: Array.from(this.sabrContexts.entries()),
            formatToDiscard: this.formatToDiscard,
            seededBufferedRanges: this.seededBufferedRanges,
            nextRequestPolicy: this.nextRequestPolicy,
            initializedFormats,
            playerTimeMs
        };
    }
    /**
     * Initiates the streaming process for the selected formats.
     * @param options - Playback options, including format preferences and initial state.
     * @throws {Error} If no suitable formats are found or streaming fails.
     * @returns A promise that resolves with the video/audio streams and selected formats.
     */
    async start(options) {
        const { videoFormat, audioFormat } = this.selectFormats(options);
        this.setupStreamingProcess(videoFormat, audioFormat, options).then();
        return {
            videoStream: this.videoStream,
            audioStream: this.audioStream,
            selectedFormats: { videoFormat, audioFormat }
        };
    }
    /**
     * Sets up and manages the main streaming loop.
     * @param videoFormat - The selected video format.
     * @param audioFormat - The selected audio format.
     * @param options - Playback options.
     * @private
     */
    async setupStreamingProcess(videoFormat, audioFormat, options) {
        try {
            this._errored = false;
            this._aborted = false;
            // `startAtMs` seeks a fresh session; `state` resumes a captured one and
            // wins if both are given, since a restored session carries its own
            // position along with the buffered ranges that justify it.
            let playerTimeMs = options.startAtMs ?? 0;
            if (options.state && this.restoreState(videoFormat, audioFormat, options.state)) {
                playerTimeMs = options.state.playerTimeMs || 0;
            }
            const maxRetries = options.maxRetries !== undefined ? options.maxRetries : DEFAULT_MAX_RETRIES;
            const enabledTrackTypes = options.enabledTrackTypes ?? EnabledTrackTypes.VIDEO_AND_AUDIO;
            // On the wire, SABR knows only audio+video (0) and audio-only (1); there
            // is no video-only value. A video-only pull is expressed as 0 with the
            // audio track discarded client-side — selected so the server initializes
            // it, advertised as fully buffered, never named as preferred. Sending 2
            // "works" for a while, but on long videos the server eventually stops
            // serving media and demands attestation. yt-dlp sends 0 and streams the
            // same videos to completion.
            const enabledTrackTypesBitfield = enabledTrackTypes === EnabledTrackTypes.VIDEO_ONLY ?
                EnabledTrackTypes.VIDEO_AND_AUDIO :
                enabledTrackTypes;
            if (options.startAtMs && !options.state) {
                const seekMs = options.startAtMs;
                this.seededBufferedRanges = [videoFormat, audioFormat]
                    .filter(Boolean)
                    .map((f) => ({
                    formatId: { itag: f.itag, lastModified: f.lastModified, xtags: f.xtags },
                    startTimeMs: '0',
                    durationMs: String(seekMs),
                    startSegmentIndex: 1,
                    endSegmentIndex: Math.max(1, Math.round(seekMs / (f.approxDurationMs || 5000))),
                    timeRange: { startTicks: '0', durationTicks: String(seekMs), timescale: 1000 }
                }));
            }
            const abrState = {
                playerTimeMs,
                audioTrackId: audioFormat.audioTrackId,
                playbackRate: 1,
                stickyResolution: videoFormat.height || 360,
                drcEnabled: audioFormat.isDrc,
                clientViewportIsFlexible: false,
                visibility: 1,
                enabledTrackTypesBitfield
            };
            // NOTE: 0 - video & audio, 1 - audio only, 2 - video only
            if (enabledTrackTypes === EnabledTrackTypes.AUDIO_ONLY || enabledTrackTypes === EnabledTrackTypes.VIDEO_ONLY) {
                this.formatToDiscard = enabledTrackTypes === EnabledTrackTypes.AUDIO_ONLY ?
                    FormatKeyUtils.fromFormat(videoFormat) :
                    FormatKeyUtils.fromFormat(audioFormat);
                this.discardedMediaType = enabledTrackTypes === EnabledTrackTypes.AUDIO_ONLY ? 'video' : 'audio';
            }
            while (parseInt(abrState.playerTimeMs) < this.durationMs) {
                if (this._aborted) {
                    this.logger.debug(TAG, 'Download process aborted, exiting streaming loop.');
                    break;
                }
                this.logger.debug(TAG, `Starting new segment fetch at playback position: ${abrState.playerTimeMs}ms`);
                this.mainFormat = enabledTrackTypes === EnabledTrackTypes.AUDIO_ONLY ?
                    this.initializedFormatsMap.get(FormatKeyUtils.fromFormat(audioFormat) || '') :
                    this.initializedFormatsMap.get(FormatKeyUtils.fromFormat(videoFormat) || '');
                if (this.mainFormat)
                    this.validateAndCorrectDuration(this.mainFormat.formatInitializationMetadata);
                // Fall back to the requested start position rather than 0: on the first
                // iteration no format is initialized yet, and resetting here discards
                // both `startAtMs` and a restored state's position.
                abrState.playerTimeMs = this.getConsumedPlayerTimeMs() ?? playerTimeMs;
                const { shouldStop } = this.checkForStall({
                    playerTimeMs: abrState.playerTimeMs,
                    stallDetectionMs: options.stallDetectionMs
                });
                if (shouldStop)
                    break;
                // Needed for the pb library.
                abrState.playerTimeMs = abrState.playerTimeMs.toString();
                const success = await this.executeWithRetry(() => this.fetchAndProcessSegments(abrState, audioFormat, videoFormat), maxRetries);
                if (!success)
                    break;
            }
        }
        catch (error) {
            if (!this._aborted) {
                this.errorHandler(error, true);
            }
        }
        finally {
            if (!this._aborted) {
                this.validateDownloadedSegments();
                if (!this._errored) {
                    this.videoController?.close();
                    this.audioController?.close();
                }
                this.resetState();
                this.emit('finish');
            }
        }
    }
    /**
     * Restores the stream state from a previously saved state object.
     * @param videoFormat - The selected video format.
     * @param audioFormat - The selected audio format.
     * @param state - The saved state object.
     * @returns `true` if the state was restored successfully, `false` otherwise.
     * @private
     */
    restoreState(videoFormat, audioFormat, state) {
        this.resetState();
        if (!state || typeof state !== 'object' || !state.initializedFormats || !Array.isArray(state.initializedFormats) || !state.durationMs || !state.playerTimeMs) {
            this.logger.warn(TAG, 'Invalid or corrupt state object provided. Starting fresh.');
            return false;
        }
        const expectedVideoFormatKey = FormatKeyUtils.fromFormat(videoFormat) || '';
        const expectedAudioFormatKey = FormatKeyUtils.fromFormat(audioFormat) || '';
        for (const format of state.initializedFormats) {
            const { formatKey, formatInitializationMetadata, downloadedSegments, lastMediaHeaders, consumedRanges } = format;
            if (formatKey !== expectedVideoFormatKey && formatKey !== expectedAudioFormatKey) {
                this.logger.warn(TAG, `State contains an unexpected format key "${formatKey}". It will be ignored.`);
                continue;
            }
            this.initializedFormatsMap.set(formatKey, {
                formatInitializationMetadata,
                downloadedSegments: new Map(downloadedSegments),
                lastMediaHeaders: lastMediaHeaders || [],
                consumedRanges: consumedRanges || []
            });
        }
        if (!this.initializedFormatsMap.has(expectedVideoFormatKey) || !this.initializedFormatsMap.has(expectedAudioFormatKey)) {
            this.logger.warn(TAG, 'State is missing required format data for the selected video/audio formats. Starting fresh.');
            this.resetState();
            return false;
        }
        this.durationMs = state.durationMs;
        this.requestNumber = state.requestNumber || 0;
        this.activeSabrContextTypes = new Set(state.activeSabrContexts || []);
        this.sabrContexts = new Map(state.sabrContextUpdates || []);
        this.formatToDiscard = state.formatToDiscard;
        this.seededBufferedRanges = state.seededBufferedRanges || [];
        this.nextRequestPolicy = state.nextRequestPolicy;
        return true;
    }
    /**
     * Checks if the download has stalled by tracking progress over time.
     * @param options - Configuration for stall detection.
     * @returns An object indicating whether the stream should stop and if it is stalled.
     * @throws {Error} If the maximum number of consecutive stalls is reached.
     * @private
     */
    checkForStall(options) {
        const currentTime = Date.now();
        const currentProgress = options.playerTimeMs;
        const stallThreshold = options.stallDetectionMs || DEFAULT_STALL_DETECTION_MS;
        if (currentProgress > this.progressTracker.lastDownloadedDuration) {
            this.progressTracker.lastProgressTime = currentTime;
            this.progressTracker.lastDownloadedDuration = currentProgress;
            this.progressTracker.stallCount = 0;
            return { shouldStop: false, stalled: false };
        }
        else if (currentTime - this.progressTracker.lastProgressTime > stallThreshold) {
            this.progressTracker.stallCount++;
            this.logger.warn(TAG, `Stream stalled for ${stallThreshold}ms (stall #${this.progressTracker.stallCount})`);
            if (this.progressTracker.stallCount >= MAX_STALLS) {
                throw new Error(`Stream stalled ${MAX_STALLS} times, aborting`);
            }
            this.progressTracker.lastProgressTime = currentTime;
            const downloadedDurationCloseness = Math.abs(this.durationMs - currentProgress);
            if (downloadedDurationCloseness < 5000) {
                this.logger.warn(TAG, 'Stream is close to completion, but stalled. Checking if we have the last segment.');
                const endSegmentNumber = parseInt(this.mainFormat?.formatInitializationMetadata.endSegmentNumber || '0') || -1;
                const lastSegment = this.mainFormat?.downloadedSegments.get(endSegmentNumber);
                if (lastSegment && lastSegment.segmentNumber === endSegmentNumber) {
                    this.logger.warn(TAG, 'Last segment is already downloaded. Stopping further processing.');
                    return { shouldStop: true, stalled: true };
                }
            }
            return { shouldStop: false, stalled: true };
        }
        return { shouldStop: false, stalled: false };
    }
    /**
     * Selects the best video and audio formats based on provided options.
     * @param options - Format selection options and quality preferences.
     * @throws {Error} If no suitable formats are found or the duration is invalid.
     * @returns The selected video and audio formats.
     * @private
     */
    selectFormats(options) {
        const videoFormat = chooseFormat(this.formatIds, options.videoFormat, {
            quality: options.videoQuality,
            preferWebM: options.preferWebM,
            preferH264: options.preferH264,
            preferMP4: options.preferMP4,
            isAudio: false
        });
        const audioFormat = chooseFormat(this.formatIds, options.audioFormat, {
            quality: options.audioQuality,
            language: options.audioLanguage,
            preferOpus: options.preferOpus,
            preferMP4: options.preferMP4,
            preferWebM: options.preferWebM,
            isAudio: true
        });
        if (this.durationMs < 0) {
            throw new Error('Invalid duration');
        }
        if (!videoFormat || !audioFormat) {
            throw new Error('No suitable formats found for download');
        }
        return { videoFormat, audioFormat };
    }
    //#endregion
    //#region --- Segment Fetching and Network Communication ---
    /**
     * Fetches and processes media segments from the server for the current ABR state.
     * @param abrState - The current client adaptive bitrate state.
     * @param selectedAudioFormat - The selected audio format.
     * @param selectedVideoFormat - The selected video format.
     * @throws {Error} If the server returns an error or no valid data.
     * @private
     */
    async fetchAndProcessSegments(abrState, selectedAudioFormat, selectedVideoFormat) {
        const initializedVideoFormat = this.initializedFormatsMap.get(FormatKeyUtils.fromFormat(selectedVideoFormat) || '');
        const initializedAudioFormat = this.initializedFormatsMap.get(FormatKeyUtils.fromFormat(selectedAudioFormat) || '');
        // Rebuild every request. `buildBufferedRanges` folds new headers into the
        // cumulative state and clears them, so a retry naturally re-sends what the
        // failed attempt sent without needing a separate cache.
        const bufferedRanges = this.buildBufferedRanges(initializedVideoFormat, initializedAudioFormat);
        const requestBody = this.buildRequestBody(abrState, selectedAudioFormat, selectedVideoFormat, bufferedRanges);
        this.mediaHeadersProcessed = false;
        const response = await this.makeStreamingRequest(requestBody);
        const processedParts = await this.processStreamingResponse(response);
        if (!processedParts.length) {
            throw new Error('No valid parts received from server.');
        }
        else if ((this.streamProtectionStatus?.status || 0) >= 2 && !processedParts.includes(UMPPartId.MEDIA)) {
            this.logger.warn(TAG, `STALL DIAGNOSTIC: protectionStatus=${this.streamProtectionStatus?.status} parts=[${processedParts.join(',')}]`);
            throw new Error('No media parts or protocol updates received from server.');
        }
        if (processedParts.includes(UMPPartId.MEDIA_HEADER) &&
            (initializedVideoFormat?.lastMediaHeaders?.length && initializedAudioFormat?.lastMediaHeaders?.length) ||
            (this.discardedMediaType !== undefined && this.mainFormat?.lastMediaHeaders?.length)) {
            this.mediaHeadersProcessed = true;
        }
    }
    /**
     * Folds any newly received media headers into each format's cumulative
     * `consumedRanges`, then returns the full buffered state to advertise.
     *
     * Calling this twice in a row is a no-op the second time: the headers it
     * consumes are cleared as it goes, so a retry re-sends exactly what the failed
     * attempt sent.
     *
     * @param initializedVideoFormat - The initialized video format, if available.
     * @param initializedAudioFormat - The initialized audio format, if available.
     * @returns Every `BufferedRange` the client currently holds.
     * @private
     */
    buildBufferedRanges(initializedVideoFormat, initializedAudioFormat) {
        const formats = [initializedVideoFormat, initializedAudioFormat];
        for (const initializedFormat of formats) {
            if (!initializedFormat?.lastMediaHeaders.length) {
                continue;
            }
            if (
            // Skip formats marked for discarding; a dummy range will be created for them later.
            FormatKeyUtils.fromFormatInitializationMetadata(initializedFormat.formatInitializationMetadata) === this.formatToDiscard) {
                initializedFormat.lastMediaHeaders = [];
                continue;
            }
            for (const header of initializedFormat.lastMediaHeaders) {
                this.recordConsumedSegment(initializedFormat, header);
            }
            initializedFormat.lastMediaHeaders = [];
        }
        return [
            ...this.seededBufferedRanges,
            ...formats.flatMap((format) => format?.consumedRanges ?? [])
        ];
    }
    /**
     * The playback position to advertise: the end of the buffered range the player
     * is currently inside.
     *
     * Summing segment durations instead drifts a few milliseconds ahead of the
     * range end, which puts the advertised position outside the advertised buffer
     * — a client claiming to play content it has not admitted to holding.
     *
     * @returns The position in ms, or undefined if nothing is buffered yet.
     * @private
     */
    getConsumedPlayerTimeMs() {
        if (!this.mainFormat?.consumedRanges.length)
            return undefined;
        const ends = this.mainFormat.consumedRanges.map((range) => parseInt(range.startTimeMs || '0') + parseInt(range.durationMs || '0'));
        return Math.max(...ends);
    }
    /**
     * Extends the range this segment continues, or opens a new one if it does not
     * continue any — which is how a gap left by a seek stays a gap.
     * @private
     */
    recordConsumedSegment(initializedFormat, header) {
        if (globalThis?.process?.env?.SABR_TRACE) {
            // eslint-disable-next-line no-console
            console.log(`[trace] mediaHeader ${JSON.stringify(header, (_k, v) => typeof v === 'bigint' ? String(v) : v)}`);
        }
        // An init segment is metadata, not content: it occupies no playback time,
        // and recording it would seed a zero-length range at sequence 0 that the
        // real segment 1 then never extends.
        if (header.isInitSeg)
            return;
        const sequenceNumber = header.sequenceNumber || 1;
        // Media headers time their segment two ways: startMs/durationMs, or
        // timeRange ticks. Some clients (a raw ANDROID_VR player response, for one)
        // send the direct fields as literal zeroes and put the real values only in
        // timeRange — so timeRange is authoritative when present, and the direct
        // fields are the fallback rather than the other way round. Trusting the
        // zeroes records every segment as zero-length, the advertised position
        // never advances, and the client re-requests position 0 until the server
        // gives up on it.
        const timescale = header.timeRange?.timescale || 0;
        const ticksToMs = (ticks) => ticks !== undefined && timescale ? Math.round((parseInt(ticks) * 1000) / timescale) : undefined;
        const startMs = ticksToMs(header.timeRange?.startTicks) ?? parseInt(header.startMs || '0');
        const durationMs = ticksToMs(header.timeRange?.durationTicks) ?? parseInt(header.durationMs || '0');
        if (initializedFormat.consumedRanges.some((range) => sequenceNumber >= (range.startSegmentIndex || 1) && sequenceNumber <= (range.endSegmentIndex || 1))) {
            return;
        }
        const contiguous = initializedFormat.consumedRanges.find((range) => range.endSegmentIndex === sequenceNumber - 1);
        if (!contiguous) {
            initializedFormat.consumedRanges.push({
                durationMs: durationMs.toString(),
                formatId: initializedFormat.formatInitializationMetadata.formatId,
                startTimeMs: startMs.toString(),
                startSegmentIndex: sequenceNumber,
                endSegmentIndex: sequenceNumber,
                timeRange: {
                    durationTicks: durationMs.toString(),
                    startTicks: startMs.toString(),
                    // The ticks above are milliseconds, so the timescale must say so. The
                    // media header's own timescale describes the media (commonly 24000);
                    // quoting it here understated every buffered range by ~24x.
                    timescale: 1000
                }
            });
            return;
        }
        const extendedMs = startMs - parseInt(contiguous.startTimeMs || '0') + durationMs;
        contiguous.endSegmentIndex = sequenceNumber;
        contiguous.durationMs = extendedMs.toString();
        if (contiguous.timeRange) {
            contiguous.timeRange.durationTicks = extendedMs.toString();
        }
    }
    /**
     * Builds the protobuf request body for a `VideoPlaybackAbrRequest`.
     * @param abrState - The current client adaptive bitrate state.
     * @param selectedAudioFormat - The selected audio format.
     * @param selectedVideoFormat - The selected video format.
     * @returns The encoded request body as a `Uint8Array`.
     * @throws {Error} If required configuration (ustreamer config, client info) is missing.
     * @private
     */
    buildRequestBody(abrState, selectedAudioFormat, selectedVideoFormat, bufferedRanges) {
        if (!this.videoPlaybackUstreamerConfig)
            throw new Error('Video playback ustreamer config must be set before starting.');
        if (!this.clientInfo)
            throw new Error('Client info must be set before starting.');
        if (globalThis?.process?.env?.SABR_TRACE) {
            // eslint-disable-next-line no-console
            console.log(`[trace] request playerTimeMs=${abrState.playerTimeMs} bufferedRanges=${JSON.stringify(bufferedRanges)}`);
        }
        const { sabrContexts, unsentSabrContexts } = this.prepareSabrContexts();
        const dumpDir = globalThis?.process?.env?.SABR_DUMP_DIR;
        const { selectedFormatIds, updatedBufferedRanges } = this.prepareFormatSelections([selectedVideoFormat, selectedAudioFormat], bufferedRanges);
        // Never ask for the track being discarded. It must still be *selected* so
        // the server initializes it and it can be marked fully buffered, but naming
        // it as preferred requests delivery of something we will throw away — and on
        // long videos the server eventually refuses the whole stream over it
        // ("attestation required" after ~60s of media, observed on three videos of
        // 25 minutes and up). yt-dlp sends an empty preferred list for a discarded
        // track and streams the same videos to completion.
        const encoded = VideoPlaybackAbrRequest.encode({
            clientAbrState: abrState,
            preferredAudioFormatIds: this.discardedMediaType === 'audio' ? [] : [selectedAudioFormat],
            preferredVideoFormatIds: this.discardedMediaType === 'video' ? [] : [selectedVideoFormat],
            preferredSubtitleFormatIds: [],
            selectedFormatIds,
            videoPlaybackUstreamerConfig: base64ToU8(this.videoPlaybackUstreamerConfig),
            streamerContext: {
                sabrContexts,
                unsentSabrContexts,
                poToken: this.poToken ? base64ToU8(this.poToken) : undefined,
                playbackCookie: this.nextRequestPolicy?.playbackCookie ? PlaybackCookie.encode(this.nextRequestPolicy.playbackCookie).finish() : undefined,
                clientInfo: this.clientInfo
            },
            bufferedRanges: updatedBufferedRanges,
            field1000: []
        }).finish();
        if (dumpDir) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = globalThis.process.getBuiltinModule?.('fs') ?? require('fs');
            fs.writeFileSync(`${dumpDir}/req-${this.requestNumber}.bin`, encoded);
        }
        return encoded;
    }
    /**
     * Prepares SABR context data for the request body.
     * @returns An object containing active and unsent SABR contexts.
     * @private
     */
    prepareSabrContexts() {
        const sabrContexts = [];
        const unsentSabrContexts = [];
        for (const ctxUpdate of this.sabrContexts.values()) {
            if (this.activeSabrContextTypes.has(ctxUpdate.type)) {
                sabrContexts.push(ctxUpdate);
            }
            else {
                unsentSabrContexts.push(ctxUpdate.type);
            }
        }
        return { sabrContexts, unsentSabrContexts };
    }
    /**
     * Prepares format selections and buffered ranges for the request body.
     * @param formats - An array of formats to process.
     * @param currentBufferedRanges - The current buffered ranges to update.
     * @returns An object with selected format IDs and updated buffered ranges.
     * @private
     */
    prepareFormatSelections(formats, currentBufferedRanges) {
        const selectedFormatIds = [];
        const updatedBufferedRanges = [...currentBufferedRanges];
        const formatsInitialized = this.initializedFormatsMap.size > 0;
        // The discarded format the server actually initialized, when it has: its
        // formatId is what the dummy range below must carry. The server is free to
        // initialize a different format for the discarded track than the one we
        // selected (observed: audio 140 selected, 251 initialized), and a
        // fully-buffered claim about a format the server is not serving means
        // nothing to it.
        const discardedInitialized = this.formatToDiscard ?
            this.initializedFormatsMap.get(this.formatToDiscard) : undefined;
        for (const format of formats) {
            const formatKey = FormatKeyUtils.fromFormat(format);
            const mediaType = format.width ? 'video' : 'audio';
            const shouldDiscard = this.formatToDiscard !== undefined &&
                (formatKey === this.formatToDiscard || mediaType === this.discardedMediaType);
            if (shouldDiscard) {
                updatedBufferedRanges.push({
                    formatId: discardedInitialized?.formatInitializationMetadata.formatId ?? format,
                    durationMs: MAX_INT32_VALUE,
                    startTimeMs: String(0),
                    // 0..MAX — the whole track, from the start. This is a claim that the
                    // track is entirely buffered; a MAX..MAX range is a zero-width claim
                    // out at infinity. yt-dlp sends 0..MAX and the server honours it.
                    startSegmentIndex: 0,
                    endSegmentIndex: parseInt(MAX_INT32_VALUE),
                    timeRange: {
                        durationTicks: MAX_INT32_VALUE,
                        startTicks: '0',
                        timescale: 1000
                    }
                });
            }
            // Only add format to selectedFormatIds when either:
            // 1. Formats have been initialized (indicating we've received their metadata).
            // 2. This format should be discarded (we want the server to acknowledge it's fully buffered).
            if (formatsInitialized || shouldDiscard) {
                selectedFormatIds.push(format);
            }
        }
        return { selectedFormatIds, updatedBufferedRanges };
    }
    /**
     * Executes a streaming POST request to the server.
     * @param body - The request body payload.
     * @returns A `Promise` that resolves with the server `Response`.
     * @throws {Error} If the server ABR streaming URL is not configured or the request fails.
     * @private
     */
    async makeStreamingRequest(body) {
        if (!this.serverAbrStreamingUrl) {
            throw new Error('Server ABR streaming URL not configured.');
        }
        const url = new URL(this.serverAbrStreamingUrl);
        url.searchParams.set('rn', this.requestNumber.toString());
        this.abortController = new AbortController();
        const timeoutId = setTimeout(() => this.abortController?.abort(), 60000);
        try {
            return await this.fetchFunction(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-protobuf',
                    'accept-encoding': 'identity',
                    'accept': 'application/vnd.yt-ump'
                },
                body: body,
                signal: this.abortController.signal
            });
        }
        finally {
            clearTimeout(timeoutId);
            this.requestNumber += 1;
        }
    }
    /**
     * Reads the response body as a stream and processes each UMP part.
     * @param response - The server response to process.
     * @returns A promise that resolves to an array of processed UMP part types.
     * @throws {Error} If the response is invalid, empty, or aborted.
     * @private
     */
    async processStreamingResponse(response) {
        if (!response.ok)
            throw new Error(`Server returned ${response.status} ${response.statusText}`);
        if (response.headers.get('content-type') !== 'application/vnd.yt-ump')
            throw new Error(`Unexpected content type from server: ${response.headers.get('content-type')}`);
        const reader = response.body.getReader();
        let dataReceived = false;
        let partialPart;
        const processedParts = [];
        while (true) {
            if (this.abortController?.signal?.aborted && !this._aborted)
                throw new Error('Stream was aborted.');
            const { done, value } = await reader.read();
            if (done) {
                if (!dataReceived) {
                    throw new Error('Received empty response from server.');
                }
                break;
            }
            dataReceived = true;
            let chunk;
            if (partialPart) {
                chunk = partialPart.data;
                chunk.append(value);
            }
            else {
                chunk = new CompositeBuffer([value]);
            }
            const ump = new UmpReader(chunk);
            partialPart = ump.read((part) => {
                processedParts.push(part.type);
                const handler = this.umpPartHandlers.get(part.type);
                if (handler) {
                    handler(part);
                }
                else {
                    // Unhandled parts are dropped. Most are advisory, but a few are
                    // instructions (SABR_SEEK, CUEPOINT_LIST), so make the drop visible
                    // rather than silent — diagnosing a stall without this is guesswork.
                    this.logger.debug(TAG, `Unhandled UMP part type=${part.type} size=${part.size}`);
                }
            });
        }
        return processedParts;
    }
    /**
     * Executes a function with automatic retries and exponential backoff.
     * Respects server-specified backoff times from `nextRequestPolicy`.
     * @param fetchFn - The function to execute.
     * @param maxRetries - The maximum number of retry attempts.
     * @returns A promise that resolves to `true` on success, or `false` if all retries fail.
     * @private
     */
    async executeWithRetry(fetchFn, maxRetries) {
        const backoffTimeMs = this.nextRequestPolicy?.backoffTimeMs || 0;
        if (backoffTimeMs > 0) {
            this.logger.debug(TAG, `Respecting server backoff policy: waiting ${backoffTimeMs}ms before request`);
            await wait(backoffTimeMs);
        }
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                await fetchFn();
                return true;
            }
            catch (e) {
                const error = e;
                if (this._aborted) {
                    this.logger.debug(TAG, 'Download process aborted, skipping retry.');
                    return false;
                }
                if (attempt > maxRetries) {
                    this.logger.error(TAG, `Maximum retries (${maxRetries}) exceeded while fetching segment: ${error.message}`);
                    this.errorHandler(error, true);
                    break;
                }
                // Re-read the server's policy on every attempt, not just once before the
                // loop. On an ad-carrying VOD the server answers a stalled request with a
                // *fresh* backoff instruction, and retrying on our own exponential
                // schedule ignores it — the request budget is then spent while the server
                // is still telling us to wait. yt-dlp does the same thing in
                // `_check_vod_ad_wait`.
                const serverBackoffMs = this.nextRequestPolicy?.backoffTimeMs || 0;
                const ourBackoffMs = Math.min(BACKOFF_MULTIPLIER * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
                const retryBackoffMs = Math.max(serverBackoffMs, ourBackoffMs);
                this.logger.warn(TAG, `Segment fetch attempt ${attempt}/${maxRetries + 1} failed - retrying in ${retryBackoffMs}ms${serverBackoffMs > ourBackoffMs ? ' (server-directed)' : ''}`, error);
                await wait(retryBackoffMs);
            }
            finally {
                this.partialSegmentQueue.clear();
            }
        }
        return false;
    }
    //#endregion
    //#region --- UMP Part Handlers ---
    /**
     * Decodes a UMP part using the provided decoder.
     * @param part
     * @param decoder
     * @private
     */
    decodePart(part, decoder) {
        if (!part.data.chunks.length)
            return undefined;
        try {
            return decoder.decode(concatenateChunks(part.data.chunks));
        }
        catch {
            return undefined;
        }
    }
    /**
     * Handles `FORMAT_INITIALIZATION_METADATA` parts.
     * Creates and stores a new `InitializedFormat` entry.
     * @private
     */
    handleFormatInitializationMetadata(part) {
        const formatInitMetadata = this.decodePart(part, FormatInitializationMetadata);
        if (!formatInitMetadata)
            return;
        const formatIdKey = FormatKeyUtils.fromFormatInitializationMetadata(formatInitMetadata);
        // The server is free to initialize a different format for a track than the
        // one selected — observed live: video-only, audio 140 selected for discard,
        // server initializes 251 instead. The discard applies to the *track*, not to
        // the exact format we happened to name, so follow the server's choice by
        // media type. Without this, every later comparison against `formatToDiscard`
        // silently misses and the discarded track fails validation at end of stream.
        if (this.discardedMediaType && formatIdKey !== this.formatToDiscard) {
            const isAudio = (formatInitMetadata.mimeType || '').startsWith('audio');
            const isVideo = (formatInitMetadata.mimeType || '').startsWith('video');
            if ((this.discardedMediaType === 'audio' && isAudio) || (this.discardedMediaType === 'video' && isVideo)) {
                this.logger.debug(TAG, `Re-keying discarded format ${this.formatToDiscard} -> ${formatIdKey} (server chose a different format for the discarded track)`);
                this.formatToDiscard = formatIdKey;
            }
        }
        const initializedFormat = {
            formatInitializationMetadata: formatInitMetadata,
            downloadedSegments: new Map(),
            lastMediaHeaders: [],
            consumedRanges: []
        };
        this.initializedFormatsMap.set(formatIdKey, initializedFormat);
        this.logger.debug(TAG, `Initialized format: ${formatIdKey}`);
        this.emit('formatInitialization', initializedFormat);
    }
    /**
     * Handles `NEXT_REQUEST_POLICY` parts.
     * Stores the server's policy for backoff time and playback cookies.
     * @private
     */
    handleNextRequestPolicy(part) {
        this.nextRequestPolicy = this.decodePart(part, NextRequestPolicy);
    }
    /**
     * Handles `SABR_ERROR` parts.
     * Throws an error to terminate the current request attempt.
     * @throws {Error} Always throws with the SABR error details.
     * @private
     */
    handleSabrError(part) {
        const sabrError = this.decodePart(part, SabrError);
        if (!sabrError)
            return;
        throw new Error(`SABR Error: ${sabrError.type} - ${sabrError.code}`);
    }
    /**
     * Handles `SABR_REDIRECT` parts.
     * Updates the streaming URL to the new location provided by the server.
     * @private
     */
    handleSabrRedirect(part) {
        const sabrRedirect = this.decodePart(part, SabrRedirect);
        if (!sabrRedirect)
            return;
        if (sabrRedirect.url) {
            this.serverAbrStreamingUrl = sabrRedirect.url;
            this.logger.debug(TAG, `Redirecting to ${this.serverAbrStreamingUrl}`);
        }
    }
    /**
     * Handles `SABR_CONTEXT_UPDATE` parts.
     * Updates the client's context state based on server instructions.
     * @private
     */
    handleSabrContextUpdate(part) {
        const sabrContextUpdate = this.decodePart(part, SabrContextUpdate);
        if (!sabrContextUpdate)
            return;
        if (sabrContextUpdate.type !== undefined && sabrContextUpdate.value?.length) {
            if (sabrContextUpdate.writePolicy === SabrContextWritePolicy.KEEP_EXISTING &&
                this.sabrContexts.has(sabrContextUpdate.type)) {
                this.logger.debug(TAG, `Skipping SABR context update for type ${sabrContextUpdate.type}`);
                return;
            }
            this.sabrContexts.set(sabrContextUpdate.type, sabrContextUpdate);
            if (sabrContextUpdate.sendByDefault) {
                this.activeSabrContextTypes.add(sabrContextUpdate.type);
            }
            this.logger.debug(TAG, `Received SABR context update (type: ${sabrContextUpdate.type}, sendByDefault: ${sabrContextUpdate.sendByDefault})`);
        }
    }
    /**
     * Handles `SABR_CONTEXT_SENDING_POLICY` parts.
     * Updates which contexts should be sent in future requests.
     * @private
     */
    handleSabrContextSendingPolicy(part) {
        const sabrContextSendingPolicy = this.decodePart(part, SabrContextSendingPolicy);
        if (!sabrContextSendingPolicy)
            return;
        for (const startPolicy of sabrContextSendingPolicy.startPolicy) {
            if (!this.activeSabrContextTypes.has(startPolicy)) {
                this.activeSabrContextTypes.add(startPolicy);
                this.logger.debug(TAG, `Activated SABR context for type ${startPolicy}`);
            }
        }
        for (const stopPolicy of sabrContextSendingPolicy.stopPolicy) {
            if (this.activeSabrContextTypes.has(stopPolicy)) {
                this.activeSabrContextTypes.delete(stopPolicy);
                this.logger.debug(TAG, `Deactivated SABR context for type ${stopPolicy}`);
            }
        }
        for (const discardPolicy of sabrContextSendingPolicy.discardPolicy) {
            if (this.sabrContexts.has(discardPolicy)) {
                this.sabrContexts.delete(discardPolicy);
                this.logger.debug(TAG, `Discarded SABR context for type ${discardPolicy}`);
            }
        }
    }
    /**
     * Handles `STREAM_PROTECTION_STATUS` parts.
     * Emits updates and handles critical statuses like required attestation.
     * @throws {Error} If attestation is required (status 3).
     * @private
     */
    handleStreamProtectionStatus(part) {
        this.streamProtectionStatus = this.decodePart(part, StreamProtectionStatus);
        if (!this.streamProtectionStatus)
            return;
        this.emit('streamProtectionStatusUpdate', this.streamProtectionStatus);
        if (this.streamProtectionStatus.status === 3) {
            throw new Error('Cannot proceed with stream: attestation required');
        }
        else if (this.streamProtectionStatus.status === 2) {
            this.logger.warn(TAG, 'Attestation pending.');
        }
    }
    /**
     * Handles `RELOAD_PLAYER_RESPONSE` parts.
     * Emits an event with reload parameters and terminates the session.
     * @throws {Error} Always throws to terminate the current streaming session.
     * @private
     */
    handleReloadPlayerResponse(part) {
        const reloadPlaybackContext = this.decodePart(part, ReloadPlaybackContext);
        if (!reloadPlaybackContext)
            return;
        const errorMessage = 'Player response reload requested by server';
        this.logger.debug(TAG, `${errorMessage} (token: ${reloadPlaybackContext.reloadPlaybackParams?.token}`);
        this.emit('reloadPlayerResponse', reloadPlaybackContext);
        throw new Error(errorMessage);
    }
    /**
     * Handles `MEDIA_HEADER` parts.
     * Creates an entry in the `partialSegmentQueue` for the upcoming media chunks.
     * @private
     */
    handleMediaHeader(part) {
        const mediaHeader = this.decodePart(part, MediaHeader);
        if (!mediaHeader)
            return;
        const headerId = mediaHeader.headerId || 0;
        const formatIdKey = FormatKeyUtils.fromMediaHeader(mediaHeader);
        const segmentNumber = mediaHeader.isInitSeg ? 0 : mediaHeader.sequenceNumber || 0;
        const durationMs = mediaHeader.durationMs || Math.ceil((parseInt(mediaHeader.timeRange?.durationTicks || '0') / (mediaHeader.timeRange?.timescale || 0)) * 1000).toString();
        const initializedFormat = this.initializedFormatsMap.get(formatIdKey);
        if (!initializedFormat) {
            this.logger.warn(TAG, `No initialized format found for key: ${formatIdKey} (segment ${segmentNumber})`);
            return;
        }
        const mediaType = getMediaType(initializedFormat);
        if (initializedFormat.downloadedSegments.has(segmentNumber)) {
            this.logger.debug(TAG, `Segment ${formatIdKey} (segment: ${segmentNumber}) already downloaded. Ignoring.`);
            return;
        }
        this.partialSegmentQueue.set(headerId, {
            formatIdKey,
            segmentNumber,
            durationMs,
            mediaHeader,
            bufferedChunks: []
        });
        this.logger.debug(TAG, `Enqueued ${mediaType} segment ${segmentNumber} (Header ID: ${headerId}, key: ${formatIdKey}, duration: ${durationMs}ms)`);
    }
    /**
     * Handles `MEDIA` parts.
     * Buffers media data chunks associated with a specific header ID.
     * @private
     */
    handleMedia(part) {
        const headerId = part.data.getUint8(0);
        const segment = this.partialSegmentQueue.get(headerId);
        if (!segment) {
            this.logger.debug(TAG, `Received Media part for an unknown Header ID: ${headerId}`);
            return;
        }
        const initializedFormat = this.initializedFormatsMap.get(segment.formatIdKey);
        if (!initializedFormat) {
            this.logger.warn(TAG, `No initialized format found for key ${segment.formatIdKey} (segment ${segment.segmentNumber})`);
            return;
        }
        const dataBuffer = part.data.split(1).remainingBuffer;
        for (const chunk of dataBuffer.chunks) {
            segment.bufferedChunks.push(chunk);
        }
    }
    /**
     * Handles `MEDIA_END` parts.
     * Finalizes a segment, enqueues its data to the appropriate stream, and updates tracking.
     * @private
     */
    handleMediaEnd(part) {
        const headerId = part.data.getUint8(0);
        const segment = this.partialSegmentQueue.get(headerId);
        if (!segment) {
            this.logger.debug(TAG, `Received MediaEnd for an unknown Header ID: ${headerId}`);
            return;
        }
        const loadedBytes = segment.bufferedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (loadedBytes !== parseInt(segment.mediaHeader.contentLength || '0')) {
            this.logger.warn(TAG, `Content length mismatch for segment ${segment.segmentNumber} (Header ID: ${headerId}, key: ${segment.formatIdKey}, expected: ${segment.mediaHeader.contentLength}, received: ${loadedBytes})`);
            this.partialSegmentQueue.delete(headerId);
            return;
        }
        const initializedFormat = this.initializedFormatsMap.get(segment.formatIdKey);
        if (initializedFormat) {
            const mediaType = getMediaType(initializedFormat);
            if (segment.bufferedChunks.length) {
                for (const chunk of segment.bufferedChunks) {
                    if (mediaType === 'audio') {
                        this.audioController?.enqueue(chunk);
                    }
                    else {
                        this.videoController?.enqueue(chunk);
                    }
                }
            }
            this.logger.debug(TAG, `Received MediaEnd for ${mediaType} segment ${segment.segmentNumber} (Header ID: ${headerId}, key: ${segment.formatIdKey})`);
            segment.bufferedChunks.length = 0; // Avoid weird mem leaks...
            segment.bufferedChunks = [];
            initializedFormat.lastMediaHeaders.push(segment.mediaHeader);
            // Fold on arrival, not when the next request is built: the playback
            // position is read from these ranges before that happens, and a position
            // derived from stale ranges lags a whole request behind.
            this.recordConsumedSegment(initializedFormat, segment.mediaHeader);
            initializedFormat.downloadedSegments.set(segment.segmentNumber, segment);
            this.partialSegmentQueue.delete(headerId);
        }
    }
    //#endregion
    //#region --- Stream Validation and Integrity Checks ---
    /**
     * Validates and corrects the stream duration based on format initialization metadata.
     * @param formatInitializationMetadata - The metadata from an initialized format.
     * @private
     */
    validateAndCorrectDuration(formatInitializationMetadata) {
        const durationUnits = parseInt(formatInitializationMetadata.durationUnits || '0');
        const durationTimescale = parseInt(formatInitializationMetadata.durationTimescale || '0');
        if (durationTimescale === 0) {
            this.logger.warn(TAG, 'Invalid timescale (0) in format initialization metadata');
            return;
        }
        const expectedDuration = Math.trunc(durationUnits / (durationTimescale / 1000));
        if (this.durationMs !== expectedDuration) {
            this.durationMs = expectedDuration;
            this.logger.debug(TAG, `Corrected stream duration to ${this.durationMs}ms based on format initialization metadata`);
        }
    }
    /**
     * Validates downloaded segments for completeness and consistency after the stream finishes.
     * Checks for duration coverage, missing segments, and duplicates.
     * @private
     */
    validateDownloadedSegments() {
        for (const [formatIdKey, initializedFormat] of this.initializedFormatsMap.entries()) {
            if (formatIdKey === this.formatToDiscard) {
                this.logger.debug(TAG, `Skipping validation for discarded format: ${formatIdKey}`);
                continue;
            }
            const totalDuration = getTotalDownloadedDuration(initializedFormat);
            const durationUnits = parseInt(initializedFormat.formatInitializationMetadata.durationUnits || '0');
            const durationTimescale = parseInt(initializedFormat.formatInitializationMetadata.durationTimescale || '0');
            const expectedDuration = durationTimescale ? durationUnits / (durationTimescale / 1000) : 0;
            const durationMismatch = Math.abs(totalDuration - expectedDuration);
            if (expectedDuration > 0 && durationMismatch > expectedDuration * 0.01) {
                const durationCoverage = Math.round((totalDuration / expectedDuration) * 100);
                this.logger.warn(TAG, `Incomplete stream for format ${formatIdKey}: downloaded ${totalDuration}ms (${durationCoverage}%), expected ${expectedDuration}ms`);
            }
            const segments = Array.from(initializedFormat.downloadedSegments.entries());
            if (segments.length === 0)
                continue;
            segments.sort(([numA], [numB]) => numA - numB);
            const expectedSegmentCount = parseInt(initializedFormat.formatInitializationMetadata.endSegmentNumber || '0');
            const missingSegments = [];
            // Find all missing segments in the expected range.
            for (let i = 0; i <= expectedSegmentCount; i++) {
                if (!initializedFormat.downloadedSegments.has(i)) {
                    missingSegments.push(i);
                }
            }
            // Check for duplicate segments (should not happen, but good to validate).
            const uniqueSegmentCount = new Set(segments.map(([num]) => num)).size;
            const hasDuplicates = uniqueSegmentCount !== segments.length;
            if (missingSegments.length > 0) {
                const message = `Format ${formatIdKey}: Missing segments: [${missingSegments.join(', ')}]. ` +
                    `Expected range: 0-${expectedSegmentCount}. `;
                this.logger.warn(TAG, message);
                this.errorHandler(new Error(message), true);
            }
            else {
                this.logger.debug(TAG, `Format ${formatIdKey}: All ${expectedSegmentCount} segments present (100% coverage)`);
            }
            if (hasDuplicates) {
                const message = `Format ${formatIdKey}: Found duplicate segment numbers (${segments.length} segments but ${uniqueSegmentCount} unique numbers)`;
                this.logger.warn(TAG, message);
                this.errorHandler(new Error(message), true);
            }
        }
    }
    //#endregion
    /**
     * Resets the internal state of the stream.
     * Clears all maps, resets counters, and re-initializes the progress tracker.
     * @private
     */
    resetState() {
        this.initializedFormatsMap.clear();
        this.partialSegmentQueue.clear();
        this.activeSabrContextTypes.clear();
        this.sabrContexts.clear();
        this.nextRequestPolicy = undefined;
        this.mainFormat = undefined;
        this.requestNumber = 0;
        this.seededBufferedRanges = [];
        this.mediaHeadersProcessed = false;
        this.streamProtectionStatus = undefined;
        this.formatToDiscard = undefined;
        this.discardedMediaType = undefined;
        this.abortController = undefined;
        this.progressTracker = {
            lastProgressTime: Date.now(),
            lastDownloadedDuration: 0,
            stallCount: 0
        };
    }
    /**
     * Handles errors during the streaming process.
     * @param error - The error that occurred.
     * @param notifyControllers - Whether to propagate the error to the stream controllers.
     * @private
     */
    errorHandler(error, notifyControllers = true) {
        this.resetState();
        this.logger.error(TAG, `Stream error: ${error.message}`);
        if (notifyControllers) {
            this._errored = true;
            this.videoController?.error(error);
            this.audioController?.error(error);
        }
    }
}
//# sourceMappingURL=SabrStream.js.map