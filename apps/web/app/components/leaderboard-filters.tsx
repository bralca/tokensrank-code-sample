"use client";

import { useRouter } from "next/navigation";
import { useRef, useTransition, type KeyboardEvent } from "react";

import {
  LEADERBOARD_LIMIT_MAX,
  type LeaderboardPeriod,
  type LeaderboardScope,
  type LeaderboardSort,
  type LeaderboardOrder,
} from "../../../../packages/shared/src/schemas/leaderboard";
import { leaderboardHref } from '../lib/leaderboard-navigation';

type LeaderboardFiltersProps = {
  period: LeaderboardPeriod;
  scope: LeaderboardScope;
  limit?: number;
  offset?: number;
  sort?: LeaderboardSort;
  order?: LeaderboardOrder;
};

type FilterOption<T extends string> = {
  label: string;
  value: T;
};

type FilterGroupProps<T extends string> = {
  label: string;
  options: Array<FilterOption<T>>;
  activeValue: T;
  hrefForValue: (value: T) => string;
  navigate: (href: string) => void;
  pending: boolean;
};

const periodOptions: Array<FilterOption<LeaderboardPeriod>> = [
  { label: "Today", value: "24h" },
  { label: "7D", value: "7d" },
  { label: "30D", value: "30d" },
  { label: "All time", value: "all" },
];

const scopeOptions: Array<FilterOption<LeaderboardScope>> = [
  { label: "All tools", value: "all" },
  { label: "Claude", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "OpenCode", value: "opencode" },
];

function filterHref({
  period,
  scope,
  limit = LEADERBOARD_LIMIT_MAX,
  offset = 0,
  sort,
  order,
}: Required<LeaderboardFiltersProps>): string {
  return leaderboardHref({ period, scope, limit, offset, sort, order });
}

function FilterGroup<T extends string>({
  label,
  options,
  activeValue,
  hrefForValue,
  navigate,
  pending,
}: FilterGroupProps<T>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusTab(index: number): void {
    tabRefs.current[index]?.focus();
  }

  function onTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusTab((index + 1) % options.length);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusTab((index - 1 + options.length) % options.length);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusTab(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusTab(options.length - 1);
    }
  }

  return (
    <div role="tablist" aria-label={label} className="dash-filter-group">
      {options.map((option, index) => {
        const isActive = option.value === activeValue;

        return (
          <button
            key={option.value}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls="leaderboard-table"
            className="dash-filter-tab"
            tabIndex={isActive ? 0 : -1}
            aria-disabled={pending}
            onClick={() => {
              if (!pending && !isActive) navigate(hrefForValue(option.value));
            }}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function LeaderboardFilters({
  period,
  scope,
  limit = LEADERBOARD_LIMIT_MAX,
  sort = 'cost',
  order = 'desc',
}: LeaderboardFiltersProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = (href: string) =>
    startTransition(() => router.push(href, { scroll: false }));
  return (
    <div className="dash-market-filters" aria-busy={pending}>
      <FilterGroup
        navigate={navigate}
        pending={pending}
        label="Filter by source"
        options={scopeOptions}
        activeValue={scope}
        hrefForValue={(value) =>
          filterHref({
            period,
            scope: value,
            limit,
            offset: 0,
            sort,
            order,
          })
        }
      />

      <FilterGroup
        navigate={navigate}
        pending={pending}
        label="Filter by period"
        options={periodOptions}
        activeValue={period}
        hrefForValue={(value) =>
          filterHref({
            period: value,
            scope,
            limit,
            offset: 0,
            sort,
            order,
          })
        }
      />
    </div>
  );
}
