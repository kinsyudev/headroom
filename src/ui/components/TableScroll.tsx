import { useEffect, useRef, useState, type ReactNode } from 'react';

export function TableScroll(props: { readonly label: string; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdge((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', read);
      ro.disconnect();
    };
  }, []);

  const scrolls = edge.start || edge.end;
  return (
    <div className="table-fade" data-start={edge.start} data-end={edge.end}>
      <div ref={ref} className="table-wrap" {...(scrolls ? { role: 'region', tabIndex: 0, 'aria-label': props.label } : {})}>
        {props.children}
      </div>
    </div>
  );
}
