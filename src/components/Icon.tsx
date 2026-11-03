import type { SVGProps } from 'react';

/** A small, consistent icon set: 20px grid, 1.6 stroke, rounded joins. */
const P: Record<string, string> = {
  camera: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h2.2l1.3-2h4l1.3 2h2.2A1.5 1.5 0 0 1 17 7.5v7A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5zM10 13.2a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4z',
  folder: 'M2.8 6.2A1.7 1.7 0 0 1 4.5 4.5h3l1.6 1.8h6.4a1.7 1.7 0 0 1 1.7 1.7v6.5a1.7 1.7 0 0 1-1.7 1.7h-11a1.7 1.7 0 0 1-1.7-1.7z',
  import: 'M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 13.5v1A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-1',
  export: 'M10 12.5V3.5m0 0L6.5 7M10 3.5 13.5 7M4 13.5v1A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-1',
  plus: 'M10 4.5v11M4.5 10h11',
  search: 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12zm4.3-1.7L17 17',
  chevronLeft: 'M12 4.5 6.5 10l5.5 5.5',
  chevronRight: 'M8 4.5l5.5 5.5L8 15.5',
  chevronDown: 'M5 7.5l5 5 5-5',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  x: 'M5.5 5.5l9 9m0-9-9 9',
  trash: 'M4 6h12M8 6V4.5h4V6m-6.5 0 .7 9.1A1.5 1.5 0 0 0 7.7 16.5h4.6a1.5 1.5 0 0 0 1.5-1.4L14.5 6',
  star: 'M10 3.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 14l-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z',
  sliders: 'M3.5 6h7m3 0h3m-13 8h3m3 0h7M12 4v4M8 12v4',
  info: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm0-4V9.5m0-2.6v.1',
  reticle: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm0-3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM10 1.5v3m0 11v3M1.5 10h3m11 0h3',
  zoom: 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12zm4.3-1.7L17 17M9 6.5v5M6.5 9h5',
  rotate: 'M15.5 9.5A5.5 5.5 0 1 1 13.8 5.5M15.5 3.5v3.3h-3.3',
  flip: 'M10 3v14M7.5 6 3.5 14h4zm5 0 4 8h-4z',
  expand: 'M3.5 7.5v-4h4m5 0h4v4m0 5v4h-4m-5 0h-4v-4',
  collapse: 'M7.5 3.5v4h-4m13 0h-4v-4m0 13v-4h4m-13 0h4v4',
  download: 'M10 3.5v9m0 0-3.5-3.5M10 12.5l3.5-3.5M4.5 16h11',
  user: 'M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 16.5a6 6 0 0 1 12 0',
  clock: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm0-10.5V10l2.5 1.5',
  keyboard: 'M3 5.5h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM5 8.5h.01M8 8.5h.01M11 8.5h.01M14 8.5h.01M6.5 11.5h7',
  sun: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM10 2v1.5m0 13V18M2 10h1.5m13 0H18M4.3 4.3l1.1 1.1m9.2 9.2 1.1 1.1m0-11.4-1.1 1.1m-9.2 9.2-1.1 1.1',
  moon: 'M16 11.8A6.5 6.5 0 0 1 8.2 4a6.5 6.5 0 1 0 7.8 7.8z',
  monitor: 'M3 4.5h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM7 17.5h6M10 14.5v3',
  compare: 'M3 4.5h5.5v11H3zm8.5 0H17v11h-5.5z',
  alert: 'M10 3.5 2.5 16.5h15zM10 8.5v3.5m0 2.2v.1',
  usb: 'M10 2.5v12m0 0a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM10 11 6.5 8.5V6.5m7 3.5V7.5M6.5 6.5h0M12 6h3v3h-3z',
  refresh: 'M16 10a6 6 0 0 1-10.6 3.8M4 10a6 6 0 0 1 10.6-3.8M14.8 2.8v3.6h-3.6M5.2 17.2v-3.6h3.6',
  edit: 'M12.5 4.5l3 3-8 8H4.5v-3zM11 6l3 3',
  image: 'M3.5 4.5h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm0 9 4-4 3 3 2-2 4 3.5M13 8.5h.01',
  grid: 'M3.5 3.5h5v5h-5zm8 0h5v5h-5zm-8 8h5v5h-5zm8 0h5v5h-5z',
  list: 'M7 5.5h10M7 10h10M7 14.5h10M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01',
  archive: 'M3 4.5h14v3H3zM4.5 7.5v7.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V7.5M8 10.5h4',
  link: 'M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9',
  pause: 'M7 4.5v11m6-11v11',
  play: 'M6.5 4.5v11l9-5.5z',
  note: 'M5 3.5h10a1 1 0 0 1 1 1v8l-4 4H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM12 16.5v-4h4M7 7.5h6M7 10.5h4',
  eye: 'M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10zM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, strokeWidth = 1.6, fill, ...rest }: { name: IconName; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      stroke="currentColor"
      strokeWidth={name === 'more' || name === 'keyboard' ? strokeWidth + 0.6 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
      fill={fill === 'currentColor' ? 'currentColor' : 'none'}
    >
      <path d={P[name]} />
    </svg>
  );
}

/** The Lumen mark: an eye crossed by a slit beam. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lm-ring" x1="0.15" y1="0.1" x2="0.85" y2="0.95">
          <stop offset="0" stopColor="#a6dcff" />
          <stop offset="0.55" stopColor="#3d8bff" />
          <stop offset="1" stopColor="#1b4fd6" />
        </linearGradient>
        <radialGradient id="lm-iris" cx="0.42" cy="0.38" r="0.7">
          <stop offset="0" stopColor="#7cc8ff" />
          <stop offset="0.6" stopColor="#2f74f0" />
          <stop offset="1" stopColor="#173c9e" />
        </radialGradient>
        <linearGradient id="lm-beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.3" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="0.7" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill="none" stroke="url(#lm-ring)" strokeWidth="1.8" />
      <circle cx="16" cy="16" r="7" fill="url(#lm-iris)" />
      <circle cx="16" cy="16" r="2.7" fill="#04070d" />
      <polygon points="19.3,1.5 20.5,1.5 12.7,30.5 11.5,30.5" fill="url(#lm-beam)" />
      <circle cx="14" cy="14" r="0.9" fill="#fff" opacity="0.9" />
    </svg>
  );
}
