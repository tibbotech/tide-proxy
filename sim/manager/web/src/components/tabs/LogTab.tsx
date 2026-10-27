import { useLayoutEffect, useRef } from 'react';
import { useLog } from '../../store';

export function LogTab() {
    const lines = useLog();
    const ref = useRef<HTMLPreElement>(null);
    const stick = useRef(true);

    useLayoutEffect(() => {
        const el = ref.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [lines]);

    return (
        <pre
            ref={ref}
            className="renode-log"
            onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
            }}
        >
            {lines.length ? lines.join('\n') : 'No output from Renode yet.'}
        </pre>
    );
}
