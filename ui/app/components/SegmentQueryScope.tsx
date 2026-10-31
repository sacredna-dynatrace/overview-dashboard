import React, { type PropsWithChildren, useMemo } from "react";
import { DqlQueryParamsProvider } from "@dynatrace-sdk/react-hooks";
import { useSegments } from "@dynatrace/strato-components/filters";

/**
 * Applies the segments picked in the SegmentSelector to every useDql call below it. useDql merges
 * this context into each call's own parameters, so no query has to pass them, and the segments are
 * part of the query key, so changing them refetches.
 *
 * A segment only narrows the data types it defines conditions for; a query reading a type the
 * segment does not cover comes back unfiltered.
 */
export const SegmentQueryScope = ({ children }: PropsWithChildren) => {
  const { segments } = useSegments();
  // A new object on every render would recompute every hook's parameters; nothing selected passes none.
  const params = useMemo(() => segments.length > 0 ? { filterSegments: segments } : {}, [segments]);
  return <DqlQueryParamsProvider {...params}>{children}</DqlQueryParamsProvider>;
};
