/**
 * Drop-in Box replacement that makes its rectangle a mouse target: onPress,
 * onWheel, hover styling (hoverBg or a render-prop `hovered` flag). Without a
 * MouseProvider above it (bare component tests), it renders as a plain Box.
 * Handlers live in a ref — re-renders never re-register the region.
 */
import React, { useContext, useEffect, useRef, useSyncExternalStore, useCallback } from "react";
import { Box, type DOMElement } from "ink";
import { MouseContext } from "./MouseProvider.js";

let nextRegionId = 1;

// Box's own ComponentProps already declares `children?: React.ReactNode`;
// intersecting (rather than overriding) would poison the function-child arm
// below (ReactNode & Function has no useful members), so Omit it first.
export type ClickableBoxProps = Omit<React.ComponentProps<typeof Box>, "children"> & {
  onPress?: () => void;
  onWheel?: (dir: 1 | -1) => void;
  hoverBg?: string;
  children?: React.ReactNode | ((hovered: boolean) => React.ReactNode);
};

export function ClickableBox({
  onPress,
  onWheel,
  hoverBg,
  children,
  ...boxProps
}: ClickableBoxProps): React.JSX.Element {
  const ctx = useContext(MouseContext);
  const store = ctx?.store ?? null;
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = nextRegionId++;
  const id = idRef.current;
  const ref = useRef<DOMElement | null>(null);
  const handlersRef = useRef<{ onPress?: () => void; onWheel?: (d: 1 | -1) => void }>({});
  handlersRef.current = { onPress, onWheel };
  // Wheel resolution filters on handler presence, so only register the keys
  // that exist THIS render (a ref-stable trampoline would advertise onWheel
  // even when the prop is absent).
  const hasPress = onPress !== undefined;
  const hasWheel = onWheel !== undefined;

  useEffect(() => {
    if (!store) return;
    return store.register(id, () => ref.current, {
      onPress: hasPress ? () => handlersRef.current.onPress?.() : undefined,
      onWheel: hasWheel ? (d) => handlersRef.current.onWheel?.(d) : undefined,
    });
  }, [store, id, hasPress, hasWheel]);

  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(id, cb) : () => {}),
    [store, id],
  );
  const hovered = useSyncExternalStore(subscribe, () => (store ? store.isHovered(id) : false));

  const bg = hovered && hoverBg !== undefined ? hoverBg : boxProps.backgroundColor;
  return (
    <Box ref={ref} {...boxProps} backgroundColor={bg}>
      {typeof children === "function" ? children(hovered) : children}
    </Box>
  );
}
