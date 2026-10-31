import React from "react";
import { Select } from "@dynatrace/strato-components/forms";
import { Text } from "@dynatrace/strato-components/typography";
import { FilterIcon } from "@dynatrace/strato-icons";

/**
 * Filters the map's services by classic tag. Several tags match any of them (OR): tags here are
 * mostly one key with different values (k8s.namespace.name:a, k8s.namespace.name:b), where AND
 * would always match nothing.
 */
type TagControlProps = {
  /** Tags in the tenant with how many services carry each, most used first. */
  options: { tag: string; count: number }[];
  value: string[];
  onChange: (value: string[]) => void;
};

export const TagControl = ({ options, value, onChange }: TagControlProps) => (
  <Select
    name="topology-tags"
    aria-label="Filter services by tag"
    multiple
    // Shown even with no tags, so the control does not seem to vanish.
    disabled={options.length === 0}
    value={value}
    onChange={(next) => onChange(next.filter((tag) => options.some((option) => option.tag === tag)))}
  >
    <Select.Trigger>
      <Select.DisplayValue>
        <Select.Prefix><FilterIcon /></Select.Prefix>
        <Text as="p">{options.length === 0 ? "No tags" : value.length === 0 ? "All tags" : value.length === 1 ? value[0] : `${value.length} tags`}</Text>
      </Select.DisplayValue>
    </Select.Trigger>
    {/* Wider than the trigger: by default the list takes the trigger's width, which cut tags off. */}
    <Select.Content width="min(420px, 90vw)" showSelectedOptionsFirst>
      <Select.Filter />
      {options.map((option) => <Select.Option key={option.tag} value={option.tag}>{option.tag} ({option.count})</Select.Option>)}
    </Select.Content>
  </Select>
);
