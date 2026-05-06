import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api/apiCall';
import { authFilesApi } from '@/services/api/authFiles';
import { usageApi } from '@/services/api/usage';
import type { GeminiKeyConfig, ProviderKeyConfig, OpenAIProviderConfig } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import { parseTimestampMs } from '@/utils/timestamp';
import {
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_USAGE_URL,
  CODEX_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  normalizeNumberValue,
  parseClaudeUsagePayload,
  parseCodexUsagePayload,
  resolveCodexChatgptAccountId,
} from '@/utils/quota';
import {
  collectUsageDetails,
  extractLatencyMs,
  extractTotalTokens,
  formatDurationMs,
  LATENCY_SOURCE_FIELD,
  normalizeAuthIndex,
  type UsageThinking,
} from '@/utils/usage';
import { downloadBlob } from '@/utils/download';
import styles from '@/pages/UsagePage.module.scss';

const ALL_FILTER = '__all__';
const MAX_RENDERED_EVENTS = 500;
const CODEX_FIVE_HOUR_SECONDS = 5 * 60 * 60;
const CODEX_SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

const DEFAULT_CALIBRATION_WEIGHTS = {
  freshInput: '2.5',
  output: '10',
  cached: '0.25',
};

type RequestEventRow = {
  id: string;
  timestamp: string;
  timestampMs: number;
  timestampLabel: string;
  model: string;
  sourceKey: string;
  sourceRaw: string;
  source: string;
  sourceType: string;
  authIndex: string;
  failed: boolean;
  latencyMs: number | null;
  thinking: UsageThinking | null;
  thinkingLabel: string;
  inputTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
};

type CalibrationProvider = 'codex' | 'claude';

type UsagePercentSnapshot = {
  provider: CalibrationProvider;
  fiveHourPercent: number | null;
  sevenDayPercent: number | null;
  fiveHourResetAt: string | null;
  sevenDayResetAt: string | null;
};

type ActiveCalibration = {
  provider: CalibrationProvider;
  model: string;
  sourceKey: string;
  source: string;
  sourceType: string;
  authIndex: string;
  startedAt: string;
  startTimestamp: string;
  startTimestampMs: number;
  startFiveHourPercent: number | null;
  startSevenDayPercent: number | null;
  startFiveHourResetAt: string | null;
  startSevenDayResetAt: string | null;
};

type CalibrationTotals = {
  freshInput: number;
  output: number;
  cached: number;
  total: number;
  rows: number;
};

export interface RequestEventsDetailsCardProps {
  usage: unknown;
  loading: boolean;
  geminiKeys: GeminiKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

const normalizeThinkingText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const formatThinkingLabel = (thinking: UsageThinking | null): string => {
  if (!thinking) return '-';

  const intensity = normalizeThinkingText(thinking.intensity);
  const level = normalizeThinkingText(thinking.level);
  const mode = normalizeThinkingText(thinking.mode);
  const budget =
    typeof thinking.budget === 'number' && Number.isFinite(thinking.budget)
      ? thinking.budget
      : null;
  const label = intensity || level || (budget !== null ? String(budget) : mode);
  const budgetLabel = budget !== null ? budget.toLocaleString() : null;

  if (!label) return '-';
  if (budgetLabel !== null && label === String(budget)) {
    return budgetLabel;
  }
  if (mode === 'budget' && budget !== null && budget > 0) {
    return `${label} (${budgetLabel})`;
  }
  if (budget === -1 && label !== 'auto') {
    return `${label} (-1)`;
  }
  return label;
};

const encodeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  const trimmedLeft = text.replace(/^\s+/, '');
  const safeText = trimmedLeft && /^[=+\-@]/.test(trimmedLeft) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
};

const getRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const getNestedRecord = (
  value: Record<string, unknown> | null,
  ...keys: string[]
): Record<string, unknown> | null => {
  if (!value) return null;
  for (const key of keys) {
    const nested = getRecord(value[key]);
    if (nested) return nested;
  }
  return null;
};

const getWindowPercent = (window: Record<string, unknown> | null): number | null =>
  normalizeNumberValue(window?.used_percent ?? window?.usedPercent ?? window?.utilization);

const getCodexWindowSeconds = (window: Record<string, unknown> | null): number | null =>
  normalizeNumberValue(window?.limit_window_seconds ?? window?.limitWindowSeconds);

const getWindowResetAt = (window: Record<string, unknown> | null): string | null => {
  if (!window) return null;
  const stringReset = window.resets_at ?? window.reset_at ?? window.resetAt;
  if (typeof stringReset === 'string' && stringReset.trim()) {
    const trimmed = stringReset.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(numeric * 1000).toISOString();
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const resetAtSeconds = normalizeNumberValue(window.reset_at ?? window.resetAt);
  if (resetAtSeconds !== null && resetAtSeconds > 0) {
    return new Date(resetAtSeconds * 1000).toISOString();
  }

  const resetAfterSeconds = normalizeNumberValue(
    window.reset_after_seconds ?? window.resetAfterSeconds
  );
  if (resetAfterSeconds !== null && resetAfterSeconds > 0) {
    return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  }

  return null;
};

const formatPercentValue = (value: number | null): string =>
  value === null ? '-' : `${value.toFixed(2)}%`;

const normalizeProvider = (value: unknown): CalibrationProvider | null => {
  const provider = String(value ?? '')
    .trim()
    .toLowerCase();
  if (provider.includes('codex')) return 'codex';
  if (provider.includes('claude') || provider.includes('anthropic')) return 'claude';
  return null;
};

const buildCalibrationWindow = (
  startPercent: number | null,
  endPercent: number | null,
  weightedTokens: number,
  weights: { freshInput: number; output: number; cached: number },
  resetAt: string | null
) => {
  if (startPercent === null || endPercent === null || weightedTokens <= 0) {
    return {
      start_percent: startPercent,
      end_percent: endPercent,
      reset_at: resetAt,
      delta_percent: null,
      delta_bps: null,
      bps_per_weighted_token: null,
      bps_per_fresh_input_token: null,
      bps_per_output_token: null,
      bps_per_cached_token: null,
    };
  }

  const deltaPercent = endPercent - startPercent;
  const deltaBps = deltaPercent * 100;
  const bpsPerWeightedToken = deltaBps / weightedTokens;

  return {
    start_percent: startPercent,
    end_percent: endPercent,
    reset_at: resetAt,
    delta_percent: deltaPercent,
    delta_bps: deltaBps,
    bps_per_weighted_token: bpsPerWeightedToken,
    bps_per_fresh_input_token: bpsPerWeightedToken * weights.freshInput,
    bps_per_output_token: bpsPerWeightedToken * weights.output,
    bps_per_cached_token: bpsPerWeightedToken * weights.cached,
  };
};

export function RequestEventsDetailsCard({
  usage,
  loading,
  geminiKeys,
  claudeConfigs,
  codexConfigs,
  vertexConfigs,
  openaiProviders,
}: RequestEventsDetailsCardProps) {
  const { t, i18n } = useTranslation();
  const latencyHint = t('usage_stats.latency_unit_hint', {
    field: LATENCY_SOURCE_FIELD,
    unit: t('usage_stats.duration_unit_ms'),
  });

  const [modelFilter, setModelFilter] = useState(ALL_FILTER);
  const [sourceFilter, setSourceFilter] = useState(ALL_FILTER);
  const [authIndexFilter, setAuthIndexFilter] = useState(ALL_FILTER);
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [authFileMap, setAuthFileMap] = useState<Map<string, CredentialInfo>>(new Map());
  const [activeCalibration, setActiveCalibration] = useState<ActiveCalibration | null>(null);
  const [calibrationWeights, setCalibrationWeights] = useState(DEFAULT_CALIBRATION_WEIGHTS);
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  const [calibrationError, setCalibrationError] = useState('');
  const [calibrationStatus, setCalibrationStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    authFilesApi
      .list()
      .then((res) => {
        if (cancelled) return;
        const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
        if (!Array.isArray(files)) return;
        setAuthFiles(files);
        const map = new Map<string, CredentialInfo>();
        files.forEach((file) => {
          const key = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
          if (!key) return;
          map.set(key, {
            name: file.name || key,
            type: (file.type || file.provider || '').toString(),
          });
        });
        setAuthFileMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: geminiKeys,
        claudeApiKeys: claudeConfigs,
        codexApiKeys: codexConfigs,
        vertexApiKeys: vertexConfigs,
        openaiCompatibility: openaiProviders,
      }),
    [claudeConfigs, codexConfigs, geminiKeys, openaiProviders, vertexConfigs]
  );

  const rows = useMemo<RequestEventRow[]>(() => {
    const details = collectUsageDetails(usage);

    const baseRows = details.map((detail, index) => {
      const timestamp = detail.timestamp;
      const timestampMs =
        typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
          ? detail.__timestampMs
          : parseTimestampMs(timestamp);
      const date = Number.isNaN(timestampMs) ? null : new Date(timestampMs);
      const sourceRaw = String(detail.source ?? '').trim();
      const authIndexRaw = detail.auth_index as unknown;
      const authIndex =
        authIndexRaw === null || authIndexRaw === undefined || authIndexRaw === ''
          ? '-'
          : String(authIndexRaw);
      const sourceInfo = resolveSourceDisplay(sourceRaw, authIndexRaw, sourceInfoMap, authFileMap);
      const source = sourceInfo.displayName;
      const sourceKey = sourceInfo.identityKey ?? `source:${sourceRaw || source}`;
      const sourceType = sourceInfo.type;
      const model = String(detail.__modelName ?? '').trim() || '-';
      const inputTokens = Math.max(toNumber(detail.tokens?.input_tokens), 0);
      const outputTokens = Math.max(toNumber(detail.tokens?.output_tokens), 0);
      const reasoningTokens = Math.max(toNumber(detail.tokens?.reasoning_tokens), 0);
      const cachedTokens = Math.max(
        Math.max(toNumber(detail.tokens?.cached_tokens), 0),
        Math.max(toNumber(detail.tokens?.cache_tokens), 0)
      );
      const freshInputTokens = Math.max(inputTokens - cachedTokens, 0);
      const totalTokens = Math.max(
        toNumber(detail.tokens?.total_tokens),
        extractTotalTokens(detail)
      );
      const latencyMs = extractLatencyMs(detail);
      const thinking = detail.thinking ?? null;
      const thinkingLabel = formatThinkingLabel(thinking);

      return {
        id: `${timestamp}-${model}-${sourceKey}-${authIndex}-${index}`,
        timestamp,
        timestampMs: Number.isNaN(timestampMs) ? 0 : timestampMs,
        timestampLabel: date ? date.toLocaleString(i18n.language) : timestamp || '-',
        model,
        sourceKey,
        sourceRaw: sourceRaw || '-',
        source,
        sourceType,
        authIndex,
        failed: detail.failed === true,
        latencyMs,
        thinking,
        thinkingLabel,
        inputTokens,
        freshInputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        totalTokens,
      };
    });

    const sourceLabelKeyMap = new Map<string, Set<string>>();
    baseRows.forEach((row) => {
      const keys = sourceLabelKeyMap.get(row.source) ?? new Set<string>();
      keys.add(row.sourceKey);
      sourceLabelKeyMap.set(row.source, keys);
    });

    const buildDisambiguatedSourceLabel = (row: RequestEventRow) => {
      const labelKeyCount = sourceLabelKeyMap.get(row.source)?.size ?? 0;
      if (labelKeyCount <= 1) {
        return row.source;
      }

      if (row.authIndex !== '-') {
        return `${row.source} · ${row.authIndex}`;
      }

      if (row.sourceRaw !== '-' && row.sourceRaw !== row.source) {
        return `${row.source} · ${row.sourceRaw}`;
      }

      if (row.sourceType) {
        return `${row.source} · ${row.sourceType}`;
      }

      return `${row.source} · ${row.sourceKey}`;
    };

    return baseRows
      .map((row) => ({
        ...row,
        source: buildDisambiguatedSourceLabel(row),
      }))
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [authFileMap, i18n.language, sourceInfoMap, usage]);

  const hasLatencyData = useMemo(() => rows.some((row) => row.latencyMs !== null), [rows]);

  const modelOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.model))).map((model) => ({
        value: model,
        label: model,
      })),
    ],
    [rows, t]
  );

  const sourceOptions = useMemo(() => {
    const optionMap = new Map<string, string>();
    rows.forEach((row) => {
      if (!optionMap.has(row.sourceKey)) {
        optionMap.set(row.sourceKey, row.source);
      }
    });

    return [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(optionMap.entries()).map(([value, label]) => ({
        value,
        label,
      })),
    ];
  }, [rows, t]);

  const authIndexOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.authIndex))).map((authIndex) => ({
        value: authIndex,
        label: authIndex,
      })),
    ],
    [rows, t]
  );

  const modelOptionSet = useMemo(
    () => new Set(modelOptions.map((option) => option.value)),
    [modelOptions]
  );
  const sourceOptionSet = useMemo(
    () => new Set(sourceOptions.map((option) => option.value)),
    [sourceOptions]
  );
  const authIndexOptionSet = useMemo(
    () => new Set(authIndexOptions.map((option) => option.value)),
    [authIndexOptions]
  );

  const effectiveModelFilter = modelOptionSet.has(modelFilter) ? modelFilter : ALL_FILTER;
  const effectiveSourceFilter = sourceOptionSet.has(sourceFilter) ? sourceFilter : ALL_FILTER;
  const effectiveAuthIndexFilter = authIndexOptionSet.has(authIndexFilter)
    ? authIndexFilter
    : ALL_FILTER;

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const modelMatched =
          effectiveModelFilter === ALL_FILTER || row.model === effectiveModelFilter;
        const sourceMatched =
          effectiveSourceFilter === ALL_FILTER || row.sourceKey === effectiveSourceFilter;
        const authIndexMatched =
          effectiveAuthIndexFilter === ALL_FILTER || row.authIndex === effectiveAuthIndexFilter;
        return modelMatched && sourceMatched && authIndexMatched;
      }),
    [effectiveAuthIndexFilter, effectiveModelFilter, effectiveSourceFilter, rows]
  );

  const renderedRows = useMemo(() => filteredRows.slice(0, MAX_RENDERED_EVENTS), [filteredRows]);
  const filteredTokenTotals = useMemo(
    () =>
      filteredRows.reduce(
        (totals, row) => ({
          freshInput: totals.freshInput + row.freshInputTokens,
          output: totals.output + row.outputTokens,
          cached: totals.cached + row.cachedTokens,
          total: totals.total + row.totalTokens,
        }),
        { freshInput: 0, output: 0, cached: 0, total: 0 }
      ),
    [filteredRows]
  );
  const calibrationSeedRow = filteredRows[0] ?? null;
  const isCalibrationActive = activeCalibration !== null;

  const findAuthFile = useCallback(
    (authIndex: string) =>
      authFiles.find(
        (file) => normalizeAuthIndex(file['auth_index'] ?? file.authIndex) === authIndex
      ),
    [authFiles]
  );

  const fetchUsagePercentSnapshot = useCallback(
    async (row: RequestEventRow): Promise<UsagePercentSnapshot> => {
      const authFile = findAuthFile(row.authIndex);
      const provider =
        normalizeProvider(authFile?.type) ??
        normalizeProvider(authFile?.provider) ??
        normalizeProvider(row.sourceType);

      if (!authFile || !provider) {
        throw new Error(t('usage_stats.calibration_unsupported_provider'));
      }

      if (provider === 'codex') {
        const accountId = resolveCodexChatgptAccountId(authFile);
        if (!accountId) {
          throw new Error(t('usage_stats.calibration_missing_account'));
        }

        const result = await apiCallApi.request({
          authIndex: row.authIndex,
          method: 'GET',
          url: CODEX_USAGE_URL,
          header: {
            ...CODEX_REQUEST_HEADERS,
            'Chatgpt-Account-Id': accountId,
          },
        });

        if (result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error(getApiCallErrorMessage(result));
        }

        const payload = parseCodexUsagePayload(result.body ?? result.bodyText);
        const rateLimit = getNestedRecord(getRecord(payload), 'rate_limit', 'rateLimit');
        const primary = getNestedRecord(rateLimit, 'primary_window', 'primaryWindow');
        const secondary = getNestedRecord(rateLimit, 'secondary_window', 'secondaryWindow');
        const primarySeconds = getCodexWindowSeconds(primary);
        const secondarySeconds = getCodexWindowSeconds(secondary);
        const fiveHour =
          primarySeconds === CODEX_FIVE_HOUR_SECONDS
            ? primary
            : secondarySeconds === CODEX_FIVE_HOUR_SECONDS
              ? secondary
              : primary;
        const sevenDay =
          primarySeconds === CODEX_SEVEN_DAY_SECONDS
            ? primary
            : secondarySeconds === CODEX_SEVEN_DAY_SECONDS
              ? secondary
              : secondary;

        return {
          provider,
          fiveHourPercent: getWindowPercent(fiveHour),
          sevenDayPercent: getWindowPercent(sevenDay),
          fiveHourResetAt: getWindowResetAt(fiveHour),
          sevenDayResetAt: getWindowResetAt(sevenDay),
        };
      }

      const result = await apiCallApi.request({
        authIndex: row.authIndex,
        method: 'GET',
        url: CLAUDE_USAGE_URL,
        header: CLAUDE_REQUEST_HEADERS,
      });

      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(getApiCallErrorMessage(result));
      }

      const payload = parseClaudeUsagePayload(result.body ?? result.bodyText);
      const payloadRecord = getRecord(payload);
      return {
        provider,
        fiveHourPercent: getWindowPercent(getNestedRecord(payloadRecord, 'five_hour')),
        sevenDayPercent: getWindowPercent(getNestedRecord(payloadRecord, 'seven_day')),
        fiveHourResetAt: getWindowResetAt(getNestedRecord(payloadRecord, 'five_hour')),
        sevenDayResetAt: getWindowResetAt(getNestedRecord(payloadRecord, 'seven_day')),
      };
    },
    [findAuthFile, t]
  );

  const calibrationRows = useMemo(
    () =>
      activeCalibration
        ? rows.filter(
            (row) =>
              row.timestampMs > activeCalibration.startTimestampMs &&
              row.model === activeCalibration.model &&
              row.sourceKey === activeCalibration.sourceKey &&
              row.authIndex === activeCalibration.authIndex
          )
        : [],
    [activeCalibration, rows]
  );

  const calibrationTotals = useMemo<CalibrationTotals>(
    () =>
      calibrationRows.reduce(
        (totals, row) => ({
          freshInput: totals.freshInput + row.freshInputTokens,
          output: totals.output + row.outputTokens,
          cached: totals.cached + row.cachedTokens,
          total: totals.total + row.totalTokens,
          rows: totals.rows + 1,
        }),
        { freshInput: 0, output: 0, cached: 0, total: 0, rows: 0 }
      ),
    [calibrationRows]
  );

  const parsedCalibrationWeights = useMemo(() => {
    const freshInput = Number(calibrationWeights.freshInput);
    const output = Number(calibrationWeights.output);
    const cached = Number(calibrationWeights.cached);
    if (
      !Number.isFinite(freshInput) ||
      !Number.isFinite(output) ||
      !Number.isFinite(cached) ||
      freshInput < 0 ||
      output < 0 ||
      cached < 0
    ) {
      return null;
    }
    return { freshInput, output, cached };
  }, [calibrationWeights]);

  const weightedCalibrationTokens = useMemo(() => {
    if (!parsedCalibrationWeights) return null;
    return (
      calibrationTotals.freshInput * parsedCalibrationWeights.freshInput +
      calibrationTotals.output * parsedCalibrationWeights.output +
      calibrationTotals.cached * parsedCalibrationWeights.cached
    );
  }, [calibrationTotals, parsedCalibrationWeights]);

  const hasActiveFilters =
    effectiveModelFilter !== ALL_FILTER ||
    effectiveSourceFilter !== ALL_FILTER ||
    effectiveAuthIndexFilter !== ALL_FILTER;

  const handleStartCalibration = async () => {
    if (!calibrationSeedRow) {
      setCalibrationError(t('usage_stats.calibration_error_no_rows'));
      return;
    }

    setCalibrationBusy(true);
    setCalibrationError('');
    setCalibrationStatus('');
    try {
      const snapshot = await fetchUsagePercentSnapshot(calibrationSeedRow);
      if (snapshot.fiveHourPercent === null && snapshot.sevenDayPercent === null) {
        throw new Error(t('usage_stats.calibration_error_no_usage'));
      }

      setActiveCalibration({
        provider: snapshot.provider,
        model: calibrationSeedRow.model,
        sourceKey: calibrationSeedRow.sourceKey,
        source: calibrationSeedRow.source,
        sourceType: calibrationSeedRow.sourceType,
        authIndex: calibrationSeedRow.authIndex,
        startedAt: new Date().toISOString(),
        startTimestamp: calibrationSeedRow.timestamp,
        startTimestampMs: calibrationSeedRow.timestampMs,
        startFiveHourPercent: snapshot.fiveHourPercent,
        startSevenDayPercent: snapshot.sevenDayPercent,
        startFiveHourResetAt: snapshot.fiveHourResetAt,
        startSevenDayResetAt: snapshot.sevenDayResetAt,
      });
      setCalibrationStatus(t('usage_stats.calibration_status_started'));
    } catch (error) {
      setCalibrationError(error instanceof Error ? error.message : String(error));
    } finally {
      setCalibrationBusy(false);
    }
  };

  const handleCancelCalibration = () => {
    setActiveCalibration(null);
    setCalibrationError('');
    setCalibrationStatus('');
  };

  const handleFinishCalibration = async () => {
    if (!activeCalibration) return;
    if (!parsedCalibrationWeights) {
      setCalibrationError(t('usage_stats.calibration_error_weights'));
      return;
    }
    if (!weightedCalibrationTokens || weightedCalibrationTokens <= 0) {
      setCalibrationError(t('usage_stats.calibration_error_no_tokens'));
      return;
    }

    const endRow = rows.find(
      (row) =>
        row.model === activeCalibration.model &&
        row.sourceKey === activeCalibration.sourceKey &&
        row.authIndex === activeCalibration.authIndex
    );
    if (!endRow) {
      setCalibrationError(t('usage_stats.calibration_error_no_rows'));
      return;
    }

    setCalibrationBusy(true);
    setCalibrationError('');
    setCalibrationStatus('');
    try {
      const endSnapshot = await fetchUsagePercentSnapshot(endRow);
      const fiveHour = buildCalibrationWindow(
        activeCalibration.startFiveHourPercent,
        endSnapshot.fiveHourPercent,
        weightedCalibrationTokens,
        parsedCalibrationWeights,
        endSnapshot.fiveHourResetAt ?? activeCalibration.startFiveHourResetAt
      );
      const sevenDay = buildCalibrationWindow(
        activeCalibration.startSevenDayPercent,
        endSnapshot.sevenDayPercent,
        weightedCalibrationTokens,
        parsedCalibrationWeights,
        endSnapshot.sevenDayResetAt ?? activeCalibration.startSevenDayResetAt
      );
      const hasDelta =
        (typeof fiveHour.delta_bps === 'number' && fiveHour.delta_bps > 0) ||
        (typeof sevenDay.delta_bps === 'number' && sevenDay.delta_bps > 0);

      if (!hasDelta) {
        throw new Error(t('usage_stats.calibration_error_no_delta'));
      }

      const record = {
        type: 'usage_percent_token_weight_calibration',
        provider: activeCalibration.provider,
        model: activeCalibration.model,
        source: activeCalibration.source,
        source_key: activeCalibration.sourceKey,
        source_type: activeCalibration.sourceType,
        auth_index: activeCalibration.authIndex,
        started_at: activeCalibration.startedAt,
        finished_at: new Date().toISOString(),
        start_event_timestamp: activeCalibration.startTimestamp,
        start_event_timestamp_ms: activeCalibration.startTimestampMs,
        assumption: 'Weighted tokens are treated as exact usage cost units.',
        weights: {
          fresh_input: parsedCalibrationWeights.freshInput,
          output: parsedCalibrationWeights.output,
          cached: parsedCalibrationWeights.cached,
        },
        sample: {
          rows: calibrationTotals.rows,
          fresh_input_tokens: calibrationTotals.freshInput,
          output_tokens: calibrationTotals.output,
          cached_tokens: calibrationTotals.cached,
          total_tokens: calibrationTotals.total,
          weighted_tokens: weightedCalibrationTokens,
        },
        windows: {
          five_hour: fiveHour,
          seven_day: sevenDay,
        },
      };

      await usageApi.saveCalibration(record);
      setActiveCalibration(null);
      setCalibrationStatus(t('usage_stats.calibration_status_saved'));
    } catch (error) {
      setCalibrationError(error instanceof Error ? error.message : String(error));
    } finally {
      setCalibrationBusy(false);
    }
  };

  const handleClearFilters = () => {
    setModelFilter(ALL_FILTER);
    setSourceFilter(ALL_FILTER);
    setAuthIndexFilter(ALL_FILTER);
  };

  const handleExportCsv = () => {
    if (!filteredRows.length) return;

    const csvHeader = [
      'timestamp',
      'model',
      'source',
      'source_raw',
      'auth_index',
      'result',
      ...(hasLatencyData ? ['latency_ms'] : []),
      'thinking_intensity',
      'thinking_mode',
      'thinking_level',
      'thinking_budget',
      'input_tokens',
      'fresh_input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'cached_tokens',
      'total_tokens',
    ];

    const csvRows = filteredRows.map((row) =>
      [
        row.timestamp,
        row.model,
        row.source,
        row.sourceRaw,
        row.authIndex,
        row.failed ? 'failed' : 'success',
        ...(hasLatencyData ? [row.latencyMs ?? ''] : []),
        row.thinking?.intensity ?? '',
        row.thinking?.mode ?? '',
        row.thinking?.level ?? '',
        row.thinking?.budget ?? '',
        row.inputTokens,
        row.freshInputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cachedTokens,
        row.totalTokens,
      ]
        .map((value) => encodeCsv(value))
        .join(',')
    );

    const content = [csvHeader.join(','), ...csvRows].join('\n');
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.csv`,
      blob: new Blob([content], { type: 'text/csv;charset=utf-8' }),
    });
  };

  const handleExportJson = () => {
    if (!filteredRows.length) return;

    const payload = filteredRows.map((row) => ({
      timestamp: row.timestamp,
      model: row.model,
      source: row.source,
      source_raw: row.sourceRaw,
      auth_index: row.authIndex,
      failed: row.failed,
      ...(hasLatencyData && row.latencyMs !== null ? { latency_ms: row.latencyMs } : {}),
      ...(row.thinking ? { thinking: row.thinking } : {}),
      tokens: {
        input_tokens: row.inputTokens,
        fresh_input_tokens: row.freshInputTokens,
        output_tokens: row.outputTokens,
        reasoning_tokens: row.reasoningTokens,
        cached_tokens: row.cachedTokens,
        total_tokens: row.totalTokens,
      },
    }));

    const content = JSON.stringify(payload, null, 2);
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.json`,
      blob: new Blob([content], { type: 'application/json;charset=utf-8' }),
    });
  };

  return (
    <Card
      title={t('usage_stats.request_events_title')}
      extra={
        <div className={styles.requestEventsActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearFilters}
            disabled={!hasActiveFilters}
          >
            {t('usage_stats.clear_filters')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_csv')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportJson}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_json')}
          </Button>
        </div>
      }
    >
      <div className={styles.requestEventsToolbar}>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_model')}
          </span>
          <Select
            value={effectiveModelFilter}
            options={modelOptions}
            onChange={setModelFilter}
            className={styles.requestEventsSelect}
            disabled={isCalibrationActive}
            ariaLabel={t('usage_stats.request_events_filter_model')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_source')}
          </span>
          <Select
            value={effectiveSourceFilter}
            options={sourceOptions}
            onChange={setSourceFilter}
            className={styles.requestEventsSelect}
            disabled={isCalibrationActive}
            ariaLabel={t('usage_stats.request_events_filter_source')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_auth_index')}
          </span>
          <Select
            value={effectiveAuthIndexFilter}
            options={authIndexOptions}
            onChange={setAuthIndexFilter}
            className={styles.requestEventsSelect}
            disabled={isCalibrationActive}
            ariaLabel={t('usage_stats.request_events_filter_auth_index')}
            fullWidth={false}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleStartCalibration}
          disabled={isCalibrationActive || !calibrationSeedRow}
          loading={calibrationBusy && !isCalibrationActive}
        >
          {t('usage_stats.calibration_start')}
        </Button>
        <div className={styles.requestEventsTokenSummary}>
          <span className={styles.requestEventsTokenSummaryTitle}>
            {t('usage_stats.request_events_filtered_tokens')}
          </span>
          <div className={styles.requestEventsTokenSummaryGrid}>
            <span className={styles.requestEventsTokenMetric}>
              <span>{t('usage_stats.fresh_input_tokens')}</span>
              <strong>{filteredTokenTotals.freshInput.toLocaleString()}</strong>
            </span>
            <span className={styles.requestEventsTokenMetric}>
              <span>{t('usage_stats.output_tokens')}</span>
              <strong>{filteredTokenTotals.output.toLocaleString()}</strong>
            </span>
            <span className={styles.requestEventsTokenMetric}>
              <span>{t('usage_stats.cached_tokens')}</span>
              <strong>{filteredTokenTotals.cached.toLocaleString()}</strong>
            </span>
            <span className={styles.requestEventsTokenMetric}>
              <span>{t('usage_stats.total_tokens')}</span>
              <strong>{filteredTokenTotals.total.toLocaleString()}</strong>
            </span>
          </div>
        </div>
      </div>

      {(activeCalibration || calibrationError || calibrationStatus) && (
        <div className={styles.calibrationPanel}>
          {activeCalibration && (
            <>
              <div className={styles.calibrationHeader}>
                <div>
                  <strong>{t('usage_stats.calibration_active_title')}</strong>
                  <span>
                    {t('usage_stats.calibration_target', {
                      model: activeCalibration.model,
                      provider: activeCalibration.provider,
                      authIndex: activeCalibration.authIndex,
                    })}
                  </span>
                </div>
                <div className={styles.calibrationUsageSnapshot}>
                  <span>
                    {t('usage_stats.calibration_start_usage', {
                      fiveHour: formatPercentValue(activeCalibration.startFiveHourPercent),
                      sevenDay: formatPercentValue(activeCalibration.startSevenDayPercent),
                    })}
                  </span>
                </div>
              </div>

              <div className={styles.calibrationGrid}>
                <div className={styles.calibrationMetric}>
                  <span>{t('usage_stats.calibration_sample_rows')}</span>
                  <strong>{calibrationTotals.rows.toLocaleString()}</strong>
                </div>
                <div className={styles.calibrationMetric}>
                  <span>{t('usage_stats.fresh_input_tokens')}</span>
                  <strong>{calibrationTotals.freshInput.toLocaleString()}</strong>
                </div>
                <div className={styles.calibrationMetric}>
                  <span>{t('usage_stats.output_tokens')}</span>
                  <strong>{calibrationTotals.output.toLocaleString()}</strong>
                </div>
                <div className={styles.calibrationMetric}>
                  <span>{t('usage_stats.cached_tokens')}</span>
                  <strong>{calibrationTotals.cached.toLocaleString()}</strong>
                </div>
                <div className={styles.calibrationMetric}>
                  <span>{t('usage_stats.calibration_weighted_tokens')}</span>
                  <strong>{weightedCalibrationTokens?.toLocaleString() ?? '-'}</strong>
                </div>
              </div>

              <div className={styles.calibrationWeights}>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  label={t('usage_stats.calibration_weight_fresh_input')}
                  value={calibrationWeights.freshInput}
                  onChange={(event) =>
                    setCalibrationWeights((current) => ({
                      ...current,
                      freshInput: event.target.value,
                    }))
                  }
                  disabled={calibrationBusy}
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  label={t('usage_stats.calibration_weight_output')}
                  value={calibrationWeights.output}
                  onChange={(event) =>
                    setCalibrationWeights((current) => ({
                      ...current,
                      output: event.target.value,
                    }))
                  }
                  disabled={calibrationBusy}
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  label={t('usage_stats.calibration_weight_cached')}
                  value={calibrationWeights.cached}
                  onChange={(event) =>
                    setCalibrationWeights((current) => ({
                      ...current,
                      cached: event.target.value,
                    }))
                  }
                  disabled={calibrationBusy}
                />
                <div className={styles.calibrationActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancelCalibration}
                    disabled={calibrationBusy}
                  >
                    {t('usage_stats.calibration_cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleFinishCalibration}
                    loading={calibrationBusy}
                  >
                    {t('usage_stats.calibration_finish')}
                  </Button>
                </div>
              </div>
            </>
          )}
          {calibrationStatus && <div className={styles.calibrationStatus}>{calibrationStatus}</div>}
          {calibrationError && <div className={styles.errorBox}>{calibrationError}</div>}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_empty_title')}
          description={t('usage_stats.request_events_empty_desc')}
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_no_result_title')}
          description={t('usage_stats.request_events_no_result_desc')}
        />
      ) : (
        <>
          <div className={styles.requestEventsMeta}>
            <span>{t('usage_stats.request_events_count', { count: filteredRows.length })}</span>
            {hasLatencyData && <span className={styles.requestEventsLimitHint}>{latencyHint}</span>}
            {filteredRows.length > MAX_RENDERED_EVENTS && (
              <span className={styles.requestEventsLimitHint}>
                {t('usage_stats.request_events_limit_hint', {
                  shown: MAX_RENDERED_EVENTS,
                  total: filteredRows.length,
                })}
              </span>
            )}
          </div>

          <div className={styles.requestEventsTableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('usage_stats.request_events_timestamp')}</th>
                  <th>{t('usage_stats.model_name')}</th>
                  <th>{t('usage_stats.request_events_source')}</th>
                  <th>{t('usage_stats.request_events_auth_index')}</th>
                  <th>{t('usage_stats.request_events_result')}</th>
                  {hasLatencyData && <th title={latencyHint}>{t('usage_stats.time')}</th>}
                  <th>{t('usage_stats.thinking_intensity')}</th>
                  <th>{t('usage_stats.input_tokens')}</th>
                  <th>{t('usage_stats.fresh_input_tokens')}</th>
                  <th>{t('usage_stats.output_tokens')}</th>
                  <th>{t('usage_stats.reasoning_tokens')}</th>
                  <th>{t('usage_stats.cached_tokens')}</th>
                  <th>{t('usage_stats.total_tokens')}</th>
                </tr>
              </thead>
              <tbody>
                {renderedRows.map((row) => (
                  <tr key={row.id}>
                    <td title={row.timestamp} className={styles.requestEventsTimestamp}>
                      {row.timestampLabel}
                    </td>
                    <td className={styles.modelCell}>{row.model}</td>
                    <td className={styles.requestEventsSourceCell} title={row.source}>
                      <span>{row.source}</span>
                      {row.sourceType && (
                        <span className={styles.credentialType}>{row.sourceType}</span>
                      )}
                    </td>
                    <td className={styles.requestEventsAuthIndex} title={row.authIndex}>
                      {row.authIndex}
                    </td>
                    <td>
                      <span
                        className={
                          row.failed
                            ? styles.requestEventsResultFailed
                            : styles.requestEventsResultSuccess
                        }
                      >
                        {row.failed ? t('stats.failure') : t('stats.success')}
                      </span>
                    </td>
                    {hasLatencyData && (
                      <td className={styles.durationCell}>{formatDurationMs(row.latencyMs)}</td>
                    )}
                    <td>
                      <span
                        className={
                          row.thinking
                            ? styles.requestEventsThinkingBadge
                            : styles.requestEventsThinkingEmpty
                        }
                        title={
                          row.thinking
                            ? [
                                row.thinking.mode
                                  ? `${t('usage_stats.thinking_mode')}: ${row.thinking.mode}`
                                  : '',
                                row.thinking.level
                                  ? `${t('usage_stats.thinking_level')}: ${row.thinking.level}`
                                  : '',
                                typeof row.thinking.budget === 'number'
                                  ? `${t('usage_stats.thinking_budget')}: ${row.thinking.budget.toLocaleString()}`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' · ')
                            : undefined
                        }
                      >
                        {row.thinkingLabel}
                      </span>
                    </td>
                    <td>{row.inputTokens.toLocaleString()}</td>
                    <td>{row.freshInputTokens.toLocaleString()}</td>
                    <td>{row.outputTokens.toLocaleString()}</td>
                    <td>{row.reasoningTokens.toLocaleString()}</td>
                    <td>{row.cachedTokens.toLocaleString()}</td>
                    <td>{row.totalTokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
