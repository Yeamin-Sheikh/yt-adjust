/**
 * Ambient type definitions for YT Adjust Chrome Extension.
 * Provides typings for Chrome extension APIs, YouTube custom elements,
 * Web Audio extensions, and SponsorBlock contracts without compiling JS.
 */

declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(
        keys?: string | string[] | Record<string, any> | null,
        callback?: (items: Record<string, any>) => void
      ): Promise<Record<string, any>>;
      set(
        items: Record<string, any>,
        callback?: () => void
      ): Promise<void>;
      remove(
        keys: string | string[],
        callback?: () => void
      ): Promise<void>;
      clear(callback?: () => void): Promise<void>;
    }

    interface StorageChange {
      oldValue?: any;
      newValue?: any;
    }

    interface StorageChanges {
      [key: string]: StorageChange;
    }

    interface StorageAreaChangedEvent {
      addListener(
        callback: (changes: StorageChanges, areaName: "sync" | "local" | "managed" | "session") => void
      ): void;
      removeListener(callback: (...args: any[]) => void): void;
      hasListener(callback: (...args: any[]) => void): boolean;
    }

    const sync: StorageArea;
    const local: StorageArea;
    const onChanged: StorageAreaChangedEvent;
  }

  namespace runtime {
    let lastError: { message?: string } | undefined;
    const id: string;
    function getURL(path: string): string;
  }
}

interface Window {
  webkitAudioContext?: typeof AudioContext;
}

interface HTMLVideoElement {
  requestVideoFrameCallback(
    callback: (now: DOMHighResTimeStamp, metadata: Record<string, any>) => void
  ): number;
  cancelVideoFrameCallback(handle: number): void;
  autoPictureInPicture?: boolean;
  disablePictureInPicture?: boolean;
}

interface MediaSession {
  setActionHandler(
    action: MediaSessionAction | "enterpictureinpicture",
    handler: ((details: MediaSessionActionDetails) => void) | null
  ): void;
}

interface YouTubePlayerElement extends HTMLElement {
  getPlaybackQualityLabel?: () => string;
  getVolume?: () => number;
  setVolume?: (volume: number) => void;
  isMuted?: () => boolean;
  unMute?: () => void;
  mute?: () => void;
  getPlaybackQuality?: () => string;
  setPlaybackQualityRange?: (quality: string) => void;
  getAvailableQualityLevels?: () => string[];
  getVideoData?: () => { video_id?: string; title?: string; [key: string]: any };
  getCurrentTime?: () => number;
  getDuration?: () => number;
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
  playVideo?: () => void;
  pauseVideo?: () => void;
  setInternalSize?: () => void;
  setSize?: (width: number, height: number) => void;
}

interface DocumentEventMap {
  "yt-navigate-finish": CustomEvent<{
    response?: any;
    endpoint?: any;
  }>;
}

interface ExtensionSettings {
  qualityEnabled: boolean;
  quality: string;
  sponsorblockEnabled: boolean;
  sponsorblockNotify: boolean;
  sponsorblockCategories: string[];
  volumeGestureEnabled: boolean;
  volumeStep: number;
  speedControlEnabled: boolean;
  speedStep: number;
  volumeBoostEnabled: boolean;
  miniPlayerEnabled: boolean;
  pipEnabled: boolean;
  pipAutoOnTabSwitch: boolean;
}

interface SponsorBlockSegment {
  category: string;
  actionType: string;
  segment: [number, number];
  UUID: string;
  videoDuration?: number;
}

interface SponsorBlockApiResponseEntry {
  videoID: string;
  hash: string;
  segments: SponsorBlockSegment[];
}
