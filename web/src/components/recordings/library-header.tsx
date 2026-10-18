import type { KeyboardEvent } from "react";
import { Link } from "react-router";
import { ArrowDownAZ, Download, GitMerge, ListChecks, Rows3, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { bulkDownloadUrl, COLLECTION_LABELS, parseDensity, parseSort, STATUS_FILTERS, type Collection, type Density, type SortOrder, type StatusFilter } from "./library-model";

export interface LibraryHeaderProps {
    collection: Collection | null;
    /** Recordings in the current collection, before search and filter. */
    total: number;
    countText: string;
    filter: StatusFilter;
    onFilterChange(value: StatusFilter): void;
    query: string;
    onQueryChange(value: string): void;
    onSearchEnter(): void;
    sort: SortOrder;
    onSortChange(value: SortOrder): void;
    density: Density;
    onDensityChange(value: Density): void;
    selectMode: boolean;
    onEnterSelectMode(): void;
    onCancelSelectMode(): void;
    /** Selected ids in list order. */
    selectedIds: string[];
    onSelectAll(): void;
    onMerge(): void;
}

const ICON_BUTTON = "text-muted-foreground hover:text-foreground sm:size-7";

/** The list header: title and count, search, the status segmented control, the count line with the icon toolbar, and the select toolbar. */
export function LibraryHeader(props: LibraryHeaderProps) {
    const { collection, total, countText, filter, query, sort, density, selectMode, selectedIds } = props;
    const title = collection ? COLLECTION_LABELS[collection] : "All recordings";

    function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "Enter") {
            event.preventDefault();
            props.onSearchEnter();
        }
    }

    return (
        <div className="bg-background lg:sticky lg:top-0 lg:z-10">
            <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
                <h2 className="min-w-0 truncate text-[17px] font-semibold">{title}</h2>
                <div className="flex shrink-0 items-baseline gap-3 text-xs tabular-nums text-muted-foreground">
                    <span>{total}</span>
                    {collection ? (
                        <Link to="/recordings" className="text-link hover:underline">
                            Clear
                        </Link>
                    ) : null}
                </div>
            </div>

            <div className="flex flex-col gap-2 border-b border-border px-3 pt-3 pb-2">
                <div className="relative">
                    <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        data-testid="recording-search"
                        type="text"
                        aria-label="Search recordings"
                        placeholder="Search recordings, transcripts..."
                        autoComplete="off"
                        value={query}
                        onChange={(event) => props.onQueryChange(event.target.value)}
                        onKeyDown={onSearchKey}
                        className="h-10 rounded-lg border-transparent bg-secondary pl-8 pr-8 shadow-none sm:h-8"
                    />
                    {query ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Clear search"
                            className="absolute right-1 top-1/2 size-8 -translate-y-1/2 sm:size-7"
                            onClick={() => props.onQueryChange("")}
                        >
                            <X />
                        </Button>
                    ) : null}
                </div>

                <fieldset className="m-0 flex w-full gap-0 rounded-lg border-0 bg-secondary p-0.5">
                    <legend className="sr-only">Filter recordings</legend>
                    {STATUS_FILTERS.map((item) => {
                        const active = filter === item.value;
                        return (
                            <button
                                key={item.value}
                                type="button"
                                data-testid={`recording-filter-${item.value}`}
                                aria-pressed={active}
                                onClick={() => props.onFilterChange(item.value)}
                                className={cn(
                                    "inline-flex h-10 min-w-0 flex-1 items-center justify-center truncate rounded-md px-1.5 text-xs transition-colors sm:h-7 sm:px-2",
                                    active ? "bg-background font-medium text-foreground shadow-sm dark:bg-accent" : "text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {item.label}
                            </button>
                        );
                    })}
                </fieldset>

                <div className="flex flex-wrap items-center justify-between gap-y-1 text-xs tabular-nums text-muted-foreground">
                    <span aria-live="polite">{selectMode ? `${selectedIds.length} selected` : countText}</span>
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                        {selectMode ? (
                            <div role="toolbar" aria-label="Selection" className="flex flex-wrap items-center justify-end gap-1">
                                <Button variant="ghost" size="sm" data-testid="recording-select-all" onClick={props.onSelectAll}>
                                    Select all
                                </Button>
                                {selectedIds.length > 0 ? (
                                    <Button asChild variant="primary" size="sm" data-testid="recording-bulk-download">
                                        <a href={bulkDownloadUrl(selectedIds)}>
                                            <Download />
                                            Download
                                        </a>
                                    </Button>
                                ) : (
                                    <Button variant="primary" size="sm" data-testid="recording-bulk-download" disabled>
                                        <Download />
                                        Download
                                    </Button>
                                )}
                                <Button
                                    variant="primary"
                                    size="sm"
                                    data-testid="recording-bulk-merge"
                                    disabled={selectedIds.length < 2}
                                    onClick={props.onMerge}
                                >
                                    <GitMerge />
                                    Merge
                                </Button>
                                <Button variant="ghost" size="sm" data-testid="recording-select-cancel" onClick={props.onCancelSelectMode}>
                                    Cancel
                                </Button>
                            </div>
                        ) : (
                            <Tooltip content="Select">
                                <Button variant="ghost" size="icon" data-testid="recording-select-mode" className={ICON_BUTTON} onClick={props.onEnterSelectMode}>
                                    <ListChecks />
                                    <span className="sr-only">Select</span>
                                </Button>
                            </Tooltip>
                        )}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="Sort" data-testid="recording-sort" className={ICON_BUTTON}>
                                    <ArrowDownAZ />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                                <DropdownMenuRadioGroup value={sort} onValueChange={(value) => props.onSortChange(parseSort(value))}>
                                    <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                                    <DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem>
                                    <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="Density" className={ICON_BUTTON}>
                                    <Rows3 />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Density</DropdownMenuLabel>
                                <DropdownMenuRadioGroup value={density} onValueChange={(value) => props.onDensityChange(parseDensity(value))}>
                                    <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
                                    <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </div>
        </div>
    );
}
