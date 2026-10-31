import React, { createContext, type PropsWithChildren, useContext, useMemo, useState } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";

/**
 * The tag filter, shared by every page so a choice made on one tab holds on the others. Segments
 * are shared the same way by the SegmentsProvider around the routes.
 *
 * Not remembered across reloads: tags belong to one tenant, and a stale filter would silently empty
 * the pages.
 */
type TagFilter = { tags: string[]; setTags: (tags: string[]) => void };
const TagFilterContext = createContext<TagFilter>({ tags: [], setTags: () => undefined });

export const TagFilterProvider = ({ children }: PropsWithChildren) => {
  const [tags, setTags] = useState<string[]>([]);
  const value = useMemo(() => ({ tags, setTags }), [tags]);
  return <TagFilterContext.Provider value={value}>{children}</TagFilterContext.Provider>;
};

export const useTagFilter = () => useContext(TagFilterContext);

/**
 * Service tags with how many services carry each, most used first - the list behind the tag
 * control on the pages that do not already load the service entities. Outside any segment, as on
 * the topology page: a segment that filtered the entities away emptied the list and hid the control.
 */
export const useServiceTagOptions = () => {
  const result = useDql({
    query: `fetch dt.entity.service
| filter isNotNull(tags)
| fields tags
| limit 25000`,
    maxResultRecords: 25000,
    filterSegments: [],
  });
  const options = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of (result.data?.records ?? []) as Record<string, unknown>[]) {
      const tags = Array.isArray(record.tags) ? new Set(record.tags.map(String).filter(Boolean)) : new Set<string>();
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [result.data]);
  return { options, isLoading: result.isLoading };
};

/** A DQL string literal. JSON's escaping (\" and \\) is the escaping DQL strings use. */
const dqlString = (value: string) => JSON.stringify(value);

/** Entity-selector values escape `~` and `"` with a leading `~`. */
const selectorValue = (value: string) => value.replace(/~/g, "~~").replace(/"/g, '~"');

/**
 * Keeps records whose service carries any of the tags (OR, like the topology map). One selector per
 * tag: within one selector, tag() conditions combine with AND. Verified on bby34718 against spans
 * (`to-be PRD` or `PRD GEN-AI`: 127 services with traffic, of 159 tagged).
 */
export const serviceTagCondition = (field: string, tags: string[]) => tags
  .map((tag) => `in(${field}, classicEntitySelector(${dqlString(`type(SERVICE),tag("${selectorValue(tag)}")`)}))`)
  .join(" or ");

/** Keeps records whose tag array holds any of the tags, e.g. a problem's `entity_tags`. */
export const tagArrayCondition = (field: string, tags: string[]) => tags
  .map((tag) => `iAny(${field}[] == ${dqlString(tag)})`)
  .join(" or ");
