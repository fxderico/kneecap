/* tslint:disable */
/* eslint-disable */
export interface FloorToFrameOptions {
    time: MediaTime;
    rate: FrameRate;
}

export interface FormatTimecodeOptions {
    time: MediaTime;
    format?: TimeCodeFormat;
    rate?: FrameRate;
}

export interface FrameRate {
    numerator: number;
    denominator: number;
}

export interface GuessTimecodeFormatOptions {
    timeCode: string;
}

export interface IsFrameAlignedOptions {
    time: MediaTime;
    rate: FrameRate;
}

export interface LastFrameTimeOptions {
    duration: MediaTime;
    rate: FrameRate;
}

export interface MediaTimeAddOptions {
    lhs: MediaTime;
    rhs: MediaTime;
}

export interface MediaTimeClampOptions {
    time: MediaTime;
    min: MediaTime;
    max: MediaTime;
}

export interface MediaTimeFromFrameOptions {
    frame: number;
    rate: FrameRate;
}

export interface MediaTimeFromSecondsOptions {
    seconds: number;
}

export interface MediaTimeMaxOptions {
    lhs: MediaTime;
    rhs: MediaTime;
}

export interface MediaTimeMinOptions {
    lhs: MediaTime;
    rhs: MediaTime;
}

export interface MediaTimeSubOptions {
    lhs: MediaTime;
    rhs: MediaTime;
}

export interface MediaTimeToFrameOptions {
    time: MediaTime;
    rate: FrameRate;
}

export interface MediaTimeToSecondsOptions {
    time: MediaTime;
}

export interface ParseTimecodeOptions {
    timeCode: string;
    format?: TimeCodeFormat;
    rate?: FrameRate;
}

export interface RoundToFrameOptions {
    time: MediaTime;
    rate: FrameRate;
}

export interface SnappedSeekTimeOptions {
    time: MediaTime;
    duration: MediaTime;
    rate: FrameRate;
}

export type MediaTime = number;

export type TimeCodeFormat = "MM:SS" | "HH:MM:SS" | "HH:MM:SS:CS" | "HH:MM:SS:FF";


export function TICKS_PER_SECOND(): number;

export function applyEffectPasses(options: any): OffscreenCanvas;

export function applyMaskFeather(options: any): OffscreenCanvas;

export function floorToFrame(arg0: FloorToFrameOptions): MediaTime | undefined;

export function formatTimecode(arg0: FormatTimecodeOptions): string | undefined;

export function getCompositorCanvas(): HTMLCanvasElement;

export function getLastFrameProfile(): Array<any>;

export function guessTimecodeFormat(arg0: GuessTimecodeFormatOptions): TimeCodeFormat | undefined;

export function initCompositor(width: number, height: number): void;

export function initializeGpu(): Promise<void>;

export function isFrameAligned(arg0: IsFrameAlignedOptions): boolean | undefined;

export function lastFrameTime(arg0: LastFrameTimeOptions): MediaTime | undefined;

export function mediaTimeAdd(arg0: MediaTimeAddOptions): MediaTime;

export function mediaTimeClamp(arg0: MediaTimeClampOptions): MediaTime;

export function mediaTimeFromFrame(arg0: MediaTimeFromFrameOptions): MediaTime | undefined;

export function mediaTimeFromSeconds(arg0: MediaTimeFromSecondsOptions): MediaTime | undefined;

export function mediaTimeMax(arg0: MediaTimeMaxOptions): MediaTime;

export function mediaTimeMin(arg0: MediaTimeMinOptions): MediaTime;

export function mediaTimeSub(arg0: MediaTimeSubOptions): MediaTime;

export function mediaTimeToFrame(arg0: MediaTimeToFrameOptions): bigint | undefined;

export function mediaTimeToSeconds(arg0: MediaTimeToSecondsOptions): number;

export function parseTimecode(arg0: ParseTimecodeOptions): MediaTime | undefined;

export function releaseTexture(id: string): void;

export function renderFrame(options: any): void;

export function resizeCompositor(width: number, height: number): void;

export function roundToFrame(arg0: RoundToFrameOptions): MediaTime | undefined;

export function snappedSeekTime(arg0: SnappedSeekTimeOptions): MediaTime | undefined;

export function uploadTexture(options: any): void;
