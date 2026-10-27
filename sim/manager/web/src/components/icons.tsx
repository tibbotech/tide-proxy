import type { ReactNode } from 'react';

// Small stroke icons (16px grid), so the UI needs no icon package.
const paths: Record<string, ReactNode> = {
    play: <path d="M4 2.5v11l9-5.5z" fill="currentColor" stroke="none" />,
    stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />,
    reset: (
        <>
            <path d="M13 8a5 5 0 1 1-1.6-3.7" />
            <path d="M13 2.5v3h-3" />
        </>
    ),
    trash: (
        <>
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
        </>
    ),
    plus: <path d="M8 3v10M3 8h10" />,
    minus: <path d="M3 8h10" />,
    fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
    upload: <path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" />,
    close: <path d="M4 4l8 8M12 4l-8 8" />,
    rail: (
        <>
            <rect x="1.5" y="5.5" width="13" height="5" rx="1" />
            <path d="M4.5 8h1M7.5 8h1M10.5 8h1" />
        </>
    ),
    chip: (
        <>
            <rect x="4" y="4" width="8" height="8" rx="1" />
            <path d="M6.5 4V2M9.5 4V2M6.5 14v-2M9.5 14v-2M4 6.5H2M4 9.5H2M14 6.5h-2M14 9.5h-2" />
        </>
    ),
    chevron: <path d="M4 6l4 4 4-4" />,
    gear: (
        <>
            <circle cx="8" cy="8" r="2" />
            <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
        </>
    ),
};

export function Icon({ name, size = 14 }: { name: keyof typeof paths; size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {paths[name]}
        </svg>
    );
}
