import React from "react";
import { Select } from "@dynatrace/strato-components/forms";
import { Text } from "@dynatrace/strato-components/typography";
import { SorterIcon } from "@dynatrace/strato-icons";
import type { TopologySort } from "./TopologyGraph";

/**
 * Which entities each column keeps when it is capped.
 *
 * "Busiest" is per column, not across the map: a column's primary metric is req/min for services,
 * container count for pods and CPU for hosts, so the labels stay generic rather than claiming a
 * single shared unit.
 */
const SORTS: { value: TopologySort; label: string }[] = [
  { value: "value", label: "Busiest" },
  { value: "problems", label: "Problems first" },
  { value: "connections", label: "Most relationships" },
  { value: "name", label: "Name (A–Z)" },
];

type SortControlProps = {
  value: TopologySort;
  onChange: (value: TopologySort) => void;
};

export const SortControl = ({ value, onChange }: SortControlProps) => {
  const selected = SORTS.find((sort) => sort.value === value) ?? SORTS[0];

  return (
    <Select
      name="topology-sort"
      aria-label="Rank entities in each column by"
      value={value}
      onChange={(next) => onChange((SORTS.find((sort) => sort.value === next) ?? SORTS[0]).value)}
    >
      <Select.Trigger>
        <Select.DisplayValue>
          <Select.Prefix><SorterIcon /></Select.Prefix>
          <Text as="p">{selected.label}</Text>
        </Select.DisplayValue>
      </Select.Trigger>
      <Select.Content>
        {SORTS.map((sort) => <Select.Option key={sort.value} value={sort.value}>{sort.label}</Select.Option>)}
      </Select.Content>
    </Select>
  );
};
