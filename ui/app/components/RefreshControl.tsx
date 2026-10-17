import React from "react";
import { Button } from "@dynatrace/strato-components/buttons";
import { Select } from "@dynatrace/strato-components/forms";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Tooltip } from "@dynatrace/strato-components/overlays";
import { Text } from "@dynatrace/strato-components/typography";
import { RefreshAutoIcon, RefreshIcon } from "@dynatrace/strato-icons";

/**
 * Auto-refresh cadences offered next to the timeframe selector. `null` means "Off".
 *
 * One minute is the shortest: every refresh reruns all of a page's queries - 17 on the topology
 * page - and the data under them does not move faster than that.
 */
const INTERVALS: { value: string; label: string; ms: number | null }[] = [
  { value: "off", label: "Off", ms: null },
  { value: "1m", label: "1 min", ms: 60_000 },
  { value: "5m", label: "5 min", ms: 300_000 },
  { value: "15m", label: "15 min", ms: 900_000 },
  { value: "1h", label: "1 hour", ms: 3_600_000 },
];

type RefreshControlProps = {
  intervalMs: number | null;
  onIntervalChange: (intervalMs: number | null) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
};

export const RefreshControl = ({ intervalMs, onIntervalChange, onRefresh, isRefreshing }: RefreshControlProps) => {
  const selected = INTERVALS.find((interval) => interval.ms === intervalMs) ?? INTERVALS[0];

  return (
    <Flex alignItems="center" gap={4}>
      <Select
        name="auto-refresh-interval"
        aria-label="Auto-refresh interval"
        value={selected.value}
        onChange={(value) => onIntervalChange(INTERVALS.find((interval) => interval.value === value)?.ms ?? null)}
      >
        <Select.Trigger>
          <Select.DisplayValue>
            <Select.Prefix><RefreshAutoIcon /></Select.Prefix>
            <Text as="p">{selected.label}</Text>
          </Select.DisplayValue>
        </Select.Trigger>
        <Select.Content>
          {INTERVALS.map((interval) => <Select.Option key={interval.value} value={interval.value}>{interval.label}</Select.Option>)}
        </Select.Content>
      </Select>
      <Tooltip text="Refresh now">
        <Button aria-label="Refresh now" onClick={onRefresh} loading={isRefreshing}>
          <Button.Prefix><RefreshIcon /></Button.Prefix>
        </Button>
      </Tooltip>
    </Flex>
  );
};
