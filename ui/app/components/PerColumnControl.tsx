import React from "react";
import { Select } from "@dynatrace/strato-components/forms";
import { Text } from "@dynatrace/strato-components/typography";
import { FormatListNumberedIcon } from "@dynatrace/strato-icons";
import { DEFAULT_DRAWN_PER_COLUMN, DRAWN_PER_COLUMN_OPTIONS } from "./TopologyGraph";

/** How many nodes each map column draws. The choice is remembered per browser. */
const STORAGE_KEY = "overview-dashboard.topology.perColumn";
export const readPerColumn = (): number => {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return (DRAWN_PER_COLUMN_OPTIONS as readonly number[]).includes(stored) ? stored : DEFAULT_DRAWN_PER_COLUMN;
  } catch {
    return DEFAULT_DRAWN_PER_COLUMN;
  }
};
const storePerColumn = (value: number) => {
  try { window.localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* the choice just is not remembered */ }
};

type PerColumnControlProps = {
  value: number;
  onChange: (value: number) => void;
};

export const PerColumnControl = ({ value, onChange }: PerColumnControlProps) => (
  <Select
    name="topology-per-column"
    aria-label="Nodes drawn per column"
    value={String(value)}
    onChange={(next) => {
      const count = Number(next);
      if (!(DRAWN_PER_COLUMN_OPTIONS as readonly number[]).includes(count)) return;
      storePerColumn(count);
      onChange(count);
    }}
  >
    <Select.Trigger>
      <Select.DisplayValue>
        <Select.Prefix><FormatListNumberedIcon /></Select.Prefix>
        <Text as="p">Top {value}</Text>
      </Select.DisplayValue>
    </Select.Trigger>
    <Select.Content>
      {DRAWN_PER_COLUMN_OPTIONS.map((count) => <Select.Option key={count} value={String(count)}>Top {count} per column</Select.Option>)}
    </Select.Content>
  </Select>
);
