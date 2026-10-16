"use client";

import {
    ArrowDownAZ,
    Download,
    GitMerge,
    ListChecks,
    Rows3,
    Search,
    X,
} from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type SortOrder = "newest" | "oldest" | "name";
export type ListDensity = "comfortable" | "compact";
export type StatusFilter =
    | "all"
    | "transcribed"
    | "processing"
    | "untranscribed";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "transcribed", label: "Transcribed" },
    { value: "processing", label: "Processing" },
    { value: "untranscribed", label: "Untranscribed" },
];

const ICON_BUTTON =
    "size-10 text-muted-foreground hover:text-foreground sm:size-7";

export function RecordingListToolbar({
    query,
    onQueryChange,
    onEnterSelectFirst,
    searchRef,
    filteredCount,
    totalCount,
    statusFilter,
    onStatusFilterChange,
    sortOrder,
    onSortOrderChange,
    density,
    onDensityChange,
    selectMode,
    selectedCount,
    onSelectModeChange,
    onSelectAll,
    downloadHref,
    onMerge,
}: {
    query: string;
    onQueryChange: (next: string) => void;
    onEnterSelectFirst: () => void;
    searchRef: React.RefObject<HTMLInputElement | null>;
    filteredCount: number;
    totalCount: number;
    statusFilter: StatusFilter;
    onStatusFilterChange: (next: StatusFilter) => void;
    sortOrder: SortOrder;
    onSortOrderChange: (next: SortOrder) => void;
    density: ListDensity;
    onDensityChange: (next: ListDensity) => void;
    selectMode: boolean;
    selectedCount: number;
    onSelectModeChange: (next: boolean) => void;
    onSelectAll: () => void;
    downloadHref: string | null;
    onMerge: () => void;
}) {
    return (
        <div className="flex flex-col gap-2 border-b border-border px-3 pt-3 pb-2">
            <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => onQueryChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            onEnterSelectFirst();
                        }
                    }}
                    placeholder="Search recordings, transcripts..."
                    className="h-10 rounded-lg border-transparent bg-secondary pl-8 pr-8 shadow-none sm:h-8"
                    aria-label="Search recordings"
                    data-testid="recording-search"
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => onQueryChange("")}
                        aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                        <X className="size-4" />
                    </button>
                )}
            </div>
            <fieldset className="m-0 flex w-full gap-0 rounded-lg bg-secondary p-0.5 border-0">
                <legend className="sr-only">Filter recordings</legend>
                {STATUS_FILTERS.map((option) => {
                    const active = statusFilter === option.value;
                    return (
                        <button
                            key={option.value}
                            type="button"
                            aria-pressed={active}
                            data-testid={`recording-filter-${option.value}`}
                            onClick={() => onStatusFilterChange(option.value)}
                            className={cn(
                                "inline-flex h-10 min-w-0 flex-1 items-center justify-center truncate rounded-md px-1.5 text-xs transition-colors sm:h-7 sm:px-2",
                                active
                                    ? "bg-background font-medium text-foreground shadow-sm dark:bg-accent"
                                    : "text-muted-foreground hover:text-foreground",
                            )}
                        >
                            {option.label}
                        </button>
                    );
                })}
            </fieldset>
            <div className="flex flex-wrap items-center justify-between gap-y-1 text-xs tabular-nums text-muted-foreground">
                {selectMode ? (
                    <span>{selectedCount} selected</span>
                ) : (
                    <span>
                        {filteredCount}
                        {query || statusFilter !== "all" ? " matching" : ""} of{" "}
                        {totalCount} recording
                        {totalCount !== 1 ? "s" : ""}
                    </span>
                )}
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                    {selectMode ? (
                        <>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-10 px-2 text-xs text-muted-foreground hover:text-foreground sm:h-6"
                                onClick={onSelectAll}
                                data-testid="recording-select-all"
                            >
                                Select all
                            </Button>
                            {downloadHref ? (
                                <Button
                                    asChild
                                    size="sm"
                                    className="h-10 px-2 text-xs sm:h-6"
                                    data-testid="recording-bulk-download"
                                >
                                    <a href={downloadHref} download>
                                        <Download className="size-3.5" />
                                        Download
                                    </a>
                                </Button>
                            ) : (
                                <Button
                                    size="sm"
                                    disabled
                                    className="h-10 px-2 text-xs sm:h-6"
                                    data-testid="recording-bulk-download"
                                >
                                    <Download className="size-3.5" />
                                    Download
                                </Button>
                            )}
                            <Button
                                size="sm"
                                disabled={selectedCount < 2}
                                onClick={onMerge}
                                className="h-10 px-2 text-xs sm:h-6"
                                data-testid="recording-bulk-merge"
                            >
                                <GitMerge className="size-3.5" />
                                Merge
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-10 px-2 text-xs text-muted-foreground hover:text-foreground sm:h-6"
                                onClick={() => onSelectModeChange(false)}
                                data-testid="recording-select-cancel"
                            >
                                Cancel
                            </Button>
                        </>
                    ) : (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className={ICON_BUTTON}
                                    onClick={() => onSelectModeChange(true)}
                                    data-testid="recording-select-mode"
                                >
                                    <ListChecks className="size-4 sm:size-3.5" />
                                    <span className="sr-only">Select</span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Select</TooltipContent>
                        </Tooltip>
                    )}
                    <DropdownMenu>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className={ICON_BUTTON}
                                        aria-label="Sort"
                                        data-testid="recording-sort"
                                    >
                                        <ArrowDownAZ className="size-4 sm:size-3.5" />
                                    </Button>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent>Sort</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                            <DropdownMenuRadioGroup
                                value={sortOrder}
                                onValueChange={(v) =>
                                    onSortOrderChange(v as SortOrder)
                                }
                            >
                                <DropdownMenuRadioItem value="newest">
                                    Newest first
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="oldest">
                                    Oldest first
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="name">
                                    Name
                                </DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenu>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className={ICON_BUTTON}
                                        aria-label="Density"
                                    >
                                        <Rows3 className="size-4 sm:size-3.5" />
                                    </Button>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent>Density</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Density</DropdownMenuLabel>
                            <DropdownMenuRadioGroup
                                value={density}
                                onValueChange={(v) =>
                                    onDensityChange(v as ListDensity)
                                }
                            >
                                <DropdownMenuRadioItem value="comfortable">
                                    Comfortable
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="compact">
                                    Compact
                                </DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </div>
    );
}
