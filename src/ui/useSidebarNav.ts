"use client";

import { useState, useEffect, useMemo } from "react";

// Shared sidebar state/behavior — extracted from FRIDAY's/TUESDAY's/CLARA's near-identical
// Sidebar.tsx (CLARA's was an explicit "direct structural port" of FRIDAY's; TUESDAY's matched
// the same shape independently). This is the stateful, error-prone part (drag-to-reorder,
// hide/show, localStorage persistence, section-grouped ordering) — deliberately NOT a full
// generic <Sidebar> component, since each app's actual markup/CSS classes/brand chrome differ
// (different design-system class names, different brand blocks, different mobile-nav content).
// Each app keeps writing its own JSX; this hook just owns the state and the two derived list
// computations that used to be duplicated verbatim in all three files.

export interface NavItemLike {
  href: string;
}

export interface UseSidebarNavResult<T extends NavItemLike> {
  mounted: boolean;
  /** Hrefs in visible (or, while customizing, full) order, grouped by section. */
  list: string[];
  byHref: Record<string, T>;
  customize: boolean;
  setCustomize: (v: boolean | ((c: boolean) => boolean)) => void;
  dragHref: string | null;
  overHref: string | null;
  hidden: string[];
  isHidden: (href: string) => boolean;
  isOver: (href: string) => boolean;
  isDragging: (href: string) => boolean;
  onDragStart: (href: string) => void;
  onDragEnter: (href: string) => void;
  onDrop: (href: string) => void;
  onDragEnterEnd: () => void;
  onDropEnd: () => void;
  onDragEnd: () => void;
  toggleHidden: (href: string) => void;
  reset: () => void;
  /**
   * Section label to render above this position in `list`, or undefined if this item continues
   * the same section as the previous one (so headers show exactly once per group).
   */
  sectionLabelAt: (index: number) => string | undefined;
}

/**
 * @param nav Full nav item list (app-specific shape, must at least have `href`).
 * @param sectionOf Classifies an href into a section name.
 * @param sectionOrder Section names in display order.
 * @param lsPrefix localStorage key prefix, e.g. "friday" → "friday.sidebar.order" / ".hidden".
 */
export function useSidebarNav<T extends NavItemLike>(
  nav: T[],
  sectionOf: (href: string) => string,
  sectionOrder: string[],
  lsPrefix: string
): UseSidebarNavResult<T> {
  const defaultOrder = useMemo(() => nav.map((n) => n.href), [nav]);
  const byHref = useMemo(() => Object.fromEntries(nav.map((n) => [n.href, n])) as Record<string, T>, [nav]);
  const lsOrderKey = `${lsPrefix}.sidebar.order`;
  const lsHiddenKey = `${lsPrefix}.sidebar.hidden`;

  const [mounted, setMounted] = useState(false);
  const [order, setOrder] = useState<string[]>(defaultOrder);
  const [hidden, setHidden] = useState<string[]>([]);
  const [customize, setCustomize] = useState(false);
  const [dragHref, setDragHref] = useState<string | null>(null);
  const [overHref, setOverHref] = useState<string | null>(null);

  // load saved prefs (client only)
  useEffect(() => {
    setMounted(true);
    try {
      const o = JSON.parse(localStorage.getItem(lsOrderKey) || "null");
      const h = JSON.parse(localStorage.getItem(lsHiddenKey) || "null");
      if (Array.isArray(o)) setOrder(o.filter((x) => typeof x === "string"));
      if (Array.isArray(h)) setHidden(h.filter((x) => typeof x === "string"));
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (mounted) try { localStorage.setItem(lsOrderKey, JSON.stringify(order)); } catch {} }, [order, mounted, lsOrderKey]);
  useEffect(() => { if (mounted) try { localStorage.setItem(lsHiddenKey, JSON.stringify(hidden)); } catch {} }, [hidden, mounted, lsHiddenKey]);

  // saved order + any NAV items not yet in it (e.g. new pages added later) appended in default position
  const fullOrder = [
    ...order.filter((h: string) => byHref[h]),
    ...defaultOrder.filter((h: string) => !order.includes(h)),
  ];
  const visible = customize ? fullOrder : fullOrder.filter((h: string) => !hidden.includes(h));
  // group by section so each header shows ONCE and all its items sit together, no matter how
  // the saved drag-order interleaves them (fixes duplicate section labels)
  const list = sectionOrder.flatMap((sec) => visible.filter((h) => sectionOf(h) === sec));

  function move(from: string, to: string) {
    if (from === to) return;
    const next = fullOrder.filter((h) => h !== from);
    const idx = to === "__end__" ? next.length : next.indexOf(to);
    next.splice(idx < 0 ? next.length : idx, 0, from);
    setOrder(next);
  }
  function toggleHidden(href: string) {
    setHidden((h: string[]) => (h.includes(href) ? h.filter((x: string) => x !== href) : [...h, href]));
  }
  function reset() { setOrder(defaultOrder); setHidden([]); }

  function sectionLabelAt(index: number): string | undefined {
    const href = list[index];
    const prevHref = index > 0 ? list[index - 1] : null;
    const sec = sectionOf(href);
    const prevSec = prevHref ? sectionOf(prevHref) : null;
    let label: string | undefined = sec !== prevSec ? sec : undefined;
    // The top section header already labels the first group — don't repeat it.
    if (index === 0 && label === sectionOrder[0]) label = undefined;
    return label;
  }

  return {
    mounted,
    list,
    byHref,
    customize,
    setCustomize,
    dragHref,
    overHref,
    hidden,
    isHidden: (href) => hidden.includes(href),
    isOver: (href) => overHref === href && dragHref !== href,
    isDragging: (href) => dragHref === href,
    onDragStart: (href) => setDragHref(href),
    onDragEnter: (href) => setOverHref(href),
    onDrop: (href) => { if (dragHref) move(dragHref, href); setDragHref(null); setOverHref(null); },
    onDragEnterEnd: () => setOverHref("__end__"),
    onDropEnd: () => { if (dragHref) move(dragHref, "__end__"); setDragHref(null); setOverHref(null); },
    onDragEnd: () => { setDragHref(null); setOverHref(null); },
    toggleHidden,
    reset,
    sectionLabelAt,
  };
}
