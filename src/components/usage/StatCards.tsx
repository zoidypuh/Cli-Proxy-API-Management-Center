import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Line } from 'react-chartjs-2';
import {
  IconDiamond,
  IconDollarSign,
  IconSatellite,
  IconTimer,
  IconTrendingUp,
} from '@/components/ui/icons';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api/apiCall';
import { authFilesApi } from '@/services/api/authFiles';
import { usageApi } from '@/services/api/usage';
import type { AuthFileItem } from '@/types/authFile';
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
  LATENCY_SOURCE_FIELD,
  calculateLatencyStatsFromDetails,
  calculateCost,
  formatCompactNumber,
  formatDurationMs,
  formatPerMinuteValue,
  formatUsd,
  collectUsageDetails,
  extractTotalTokens,
  normalizeAuthIndex,
  type ModelPrice,
} from '@/utils/usage';
import { sparklineOptions } from '@/utils/usage/chartConfig';
import type { UsagePayload } from './hooks/useUsageData';
import type { SparklineBundle } from './hooks/useSparklines';
import styles from '@/pages/UsagePage.module.scss';

const CODEX_SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

interface StatCardData {
  key: string;
  label: string;
  icon: ReactNode;
  accent: string;
  accentSoft: string;
  accentBorder: string;
  value: string;
  meta?: ReactNode;
  trend: SparklineBundle | null;
}

type SevenDayCalibration = {
  provider: 'codex' | 'claude';
  model: string;
  authIndex: string;
  timestampMs: number;
  currentPercent: number | null;
  resetAtMs: number | null;
  rates: {
    freshInputBps: number;
    outputBps: number;
    cachedBps: number;
  };
};

type LiveUsageWindow = {
  currentPercent: number | null;
  resetAtMs: number | null;
};

type UsageProjection = {
  percent: number;
  percentPerMinute: number | null;
  projectedRemainingAtReset: number | null;
};

export interface StatCardsProps {
  usage: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  nowMs: number;
  timeRangeMinutes: number | null;
  sparklines: {
    requests: SparklineBundle | null;
    tokens: SparklineBundle | null;
    rpm: SparklineBundle | null;
    tpm: SparklineBundle | null;
    cost: SparklineBundle | null;
  };
}

const toNumberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

const parseDateMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const resolveResetAtMs = (value: unknown): number | null => {
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric * 1000;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const numeric = toNumberOrNull(value);
  return numeric !== null && numeric > 0 ? numeric * 1000 : null;
};

const getWindowPercent = (window: Record<string, unknown> | null): number | null =>
  normalizeNumberValue(window?.used_percent ?? window?.usedPercent ?? window?.utilization);

const getCodexWindowSeconds = (window: Record<string, unknown> | null): number | null =>
  normalizeNumberValue(window?.limit_window_seconds ?? window?.limitWindowSeconds);

const getWindowResetAtMs = (window: Record<string, unknown> | null): number | null => {
  if (!window) return null;
  const direct = resolveResetAtMs(window.resets_at ?? window.reset_at ?? window.resetAt);
  if (direct !== null) return direct;

  const resetAfterSeconds = normalizeNumberValue(
    window.reset_after_seconds ?? window.resetAfterSeconds
  );
  return resetAfterSeconds !== null && resetAfterSeconds > 0
    ? Date.now() + resetAfterSeconds * 1000
    : null;
};

const normalizeProvider = (value: unknown): 'codex' | 'claude' | null => {
  const provider = String(value ?? '')
    .trim()
    .toLowerCase();
  if (provider.includes('codex')) return 'codex';
  if (provider.includes('claude') || provider.includes('anthropic')) return 'claude';
  return null;
};

const parseSevenDayCalibration = (record: Record<string, unknown>): SevenDayCalibration | null => {
  if (record.type !== 'usage_percent_token_weight_calibration') return null;

  const provider = normalizeProvider(record.provider);
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  const authIndex =
    typeof record.auth_index === 'string'
      ? record.auth_index.trim()
      : typeof record.authIndex === 'string'
        ? record.authIndex.trim()
        : '';
  if (!provider || !model || !authIndex) return null;

  const windows = getRecord(record.windows);
  const sevenDay = getRecord(windows?.seven_day ?? windows?.sevenDay);
  if (!sevenDay) return null;

  const weights = getRecord(record.weights);
  const weightedBps = toNumberOrNull(sevenDay.bps_per_weighted_token);
  const freshInputBps =
    toNumberOrNull(sevenDay.bps_per_fresh_input_token) ??
    (weightedBps !== null ? weightedBps * (toNumberOrNull(weights?.fresh_input) ?? 0) : null);
  const outputBps =
    toNumberOrNull(sevenDay.bps_per_output_token) ??
    (weightedBps !== null ? weightedBps * (toNumberOrNull(weights?.output) ?? 0) : null);
  const cachedBps =
    toNumberOrNull(sevenDay.bps_per_cached_token) ??
    (weightedBps !== null ? weightedBps * (toNumberOrNull(weights?.cached) ?? 0) : null);

  if (freshInputBps === null || outputBps === null || cachedBps === null) return null;

  return {
    provider,
    model,
    authIndex,
    timestampMs:
      parseDateMs(record.finished_at) ??
      parseDateMs(record.recorded_at) ??
      parseDateMs(record.started_at) ??
      0,
    currentPercent: toNumberOrNull(sevenDay.end_percent),
    resetAtMs: resolveResetAtMs(sevenDay.reset_at ?? sevenDay.resetAt),
    rates: {
      freshInputBps,
      outputBps,
      cachedBps,
    },
  };
};

const formatPercent = (value: number, digits = 2): string => `${value.toFixed(digits)}%`;

const calibrationKey = (calibration: Pick<SevenDayCalibration, 'model' | 'authIndex'>): string =>
  `${calibration.model}\n${calibration.authIndex}`;

const fetchLiveSevenDayWindow = async (
  calibration: SevenDayCalibration,
  authFile: AuthFileItem
): Promise<LiveUsageWindow | null> => {
  if (calibration.provider === 'codex') {
    const accountId = resolveCodexChatgptAccountId(authFile);
    if (!accountId) return null;

    const result = await apiCallApi.request({
      authIndex: calibration.authIndex,
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
    const sevenDay =
      primarySeconds === CODEX_SEVEN_DAY_SECONDS
        ? primary
        : secondarySeconds === CODEX_SEVEN_DAY_SECONDS
          ? secondary
          : secondary;

    return {
      currentPercent: getWindowPercent(sevenDay),
      resetAtMs: getWindowResetAtMs(sevenDay),
    };
  }

  const result = await apiCallApi.request({
    authIndex: calibration.authIndex,
    method: 'GET',
    url: CLAUDE_USAGE_URL,
    header: CLAUDE_REQUEST_HEADERS,
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(getApiCallErrorMessage(result));
  }

  const payload = parseClaudeUsagePayload(result.body ?? result.bodyText);
  const sevenDay = getNestedRecord(getRecord(payload), 'seven_day');
  return {
    currentPercent: getWindowPercent(sevenDay),
    resetAtMs: getWindowResetAtMs(sevenDay),
  };
};

export function StatCards({
  usage,
  loading,
  modelPrices,
  nowMs,
  timeRangeMinutes,
  sparklines,
}: StatCardsProps) {
  const { t } = useTranslation();
  const [calibrations, setCalibrations] = useState<Record<string, unknown>[]>([]);
  const [liveUsageWindows, setLiveUsageWindows] = useState<Map<string, LiveUsageWindow>>(
    () => new Map()
  );
  const latencyHint = t('usage_stats.latency_unit_hint', {
    field: LATENCY_SOURCE_FIELD,
    unit: t('usage_stats.duration_unit_ms'),
  });

  const hasPrices = Object.keys(modelPrices).length > 0;

  useEffect(() => {
    let cancelled = false;
    usageApi
      .getCalibrations()
      .then((store) => {
        if (cancelled) return;
        setCalibrations(Array.isArray(store?.calibrations) ? store.calibrations : []);
      })
      .catch(() => {
        if (!cancelled) setCalibrations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [nowMs]);

  const sevenDayCalibrationIndex = useMemo(() => {
    const byExact = new Map<string, SevenDayCalibration>();
    const byModel = new Map<string, SevenDayCalibration>();

    calibrations
      .map(parseSevenDayCalibration)
      .filter((item): item is SevenDayCalibration => item !== null)
      .forEach((calibration) => {
        const exactKey = `${calibration.model}\n${calibration.authIndex}`;
        const previousExact = byExact.get(exactKey);
        if (!previousExact || previousExact.timestampMs <= calibration.timestampMs) {
          byExact.set(exactKey, calibration);
        }
        const previousModel = byModel.get(calibration.model);
        if (!previousModel || previousModel.timestampMs <= calibration.timestampMs) {
          byModel.set(calibration.model, calibration);
        }
      });

    return { byExact, byModel };
  }, [calibrations]);

  useEffect(() => {
    let cancelled = false;

    const latestCalibrations = Array.from(sevenDayCalibrationIndex.byExact.values());
    if (!latestCalibrations.length) {
      setLiveUsageWindows(new Map());
      return () => {
        cancelled = true;
      };
    }

    authFilesApi
      .list()
      .then(async (res) => {
        const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
        if (!Array.isArray(files)) return new Map<string, LiveUsageWindow>();

        const authFileByIndex = new Map<string, AuthFileItem>();
        files.forEach((file) => {
          const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
          if (authIndex) authFileByIndex.set(authIndex, file);
        });

        const entries = await Promise.all(
          latestCalibrations.map(async (calibration) => {
            const authFile = authFileByIndex.get(calibration.authIndex);
            if (!authFile) return null;
            try {
              const liveWindow = await fetchLiveSevenDayWindow(calibration, authFile);
              return liveWindow ? ([calibrationKey(calibration), liveWindow] as const) : null;
            } catch {
              return null;
            }
          })
        );

        return new Map(
          entries.filter((entry): entry is readonly [string, LiveUsageWindow] => !!entry)
        );
      })
      .then((next) => {
        if (!cancelled && next) setLiveUsageWindows(next);
      })
      .catch(() => {
        if (!cancelled) setLiveUsageWindows(new Map());
      });

    return () => {
      cancelled = true;
    };
  }, [sevenDayCalibrationIndex, nowMs]);

  const { tokenBreakdown, rateStats, totalCost, latencyStats, usageProjection } = useMemo(() => {
    const empty = {
      tokenBreakdown: { cachedTokens: 0, reasoningTokens: 0 },
      rateStats: { rpm: 0, tpm: 0, windowMinutes: 30, requestCount: 0, tokenCount: 0 },
      totalCost: 0,
      latencyStats: {
        averageMs: null as number | null,
        totalMs: null as number | null,
        sampleCount: 0,
      },
      usageProjection: null as UsageProjection | null,
    };

    if (!usage) return empty;
    const details = collectUsageDetails(usage);
    if (!details.length) return empty;

    const latencyStats = calculateLatencyStatsFromDetails(details);

    let cachedTokens = 0;
    let reasoningTokens = 0;
    let totalCost = 0;
    let sevenDayUsageBps = 0;
    const matchedCalibrations: SevenDayCalibration[] = [];

    const now = nowMs;
    const windowMinutes = 30;
    const windowStart = now - windowMinutes * 60 * 1000;
    let requestCount = 0;
    let tokenCount = 0;
    const hasValidNow = Number.isFinite(now) && now > 0;

    details.forEach((detail) => {
      const tokens = detail.tokens;
      cachedTokens += Math.max(
        typeof tokens.cached_tokens === 'number' ? Math.max(tokens.cached_tokens, 0) : 0,
        typeof tokens.cache_tokens === 'number' ? Math.max(tokens.cache_tokens, 0) : 0
      );
      if (typeof tokens.reasoning_tokens === 'number') {
        reasoningTokens += tokens.reasoning_tokens;
      }

      const timestamp = detail.__timestampMs ?? 0;
      if (
        hasValidNow &&
        Number.isFinite(timestamp) &&
        timestamp >= windowStart &&
        timestamp <= now
      ) {
        requestCount += 1;
        tokenCount += extractTotalTokens(detail);
      }

      if (hasPrices) {
        totalCost += calculateCost(detail, modelPrices);
      }

      const model = detail.__modelName ?? '';
      const authIndex =
        detail.auth_index === null || detail.auth_index === undefined
          ? ''
          : String(detail.auth_index);
      const calibration =
        sevenDayCalibrationIndex.byExact.get(`${model}\n${authIndex}`) ??
        sevenDayCalibrationIndex.byModel.get(model) ??
        null;

      if (calibration) {
        const inputTokens =
          typeof tokens.input_tokens === 'number' ? Math.max(tokens.input_tokens, 0) : 0;
        const outputTokens =
          typeof tokens.output_tokens === 'number' ? Math.max(tokens.output_tokens, 0) : 0;
        const cached = Math.max(
          typeof tokens.cached_tokens === 'number' ? Math.max(tokens.cached_tokens, 0) : 0,
          typeof tokens.cache_tokens === 'number' ? Math.max(tokens.cache_tokens, 0) : 0
        );
        const freshInput = Math.max(inputTokens - cached, 0);
        sevenDayUsageBps +=
          freshInput * calibration.rates.freshInputBps +
          outputTokens * calibration.rates.outputBps +
          cached * calibration.rates.cachedBps;

        matchedCalibrations.push(calibration);
      }
    });

    const estimatedPercent = sevenDayUsageBps / 100;
    const actualSpanMinutes = details.length
      ? Math.max(
          1,
          (Math.max(...details.map((detail) => detail.__timestampMs ?? 0)) -
            Math.min(...details.map((detail) => detail.__timestampMs ?? 0))) /
            60000
        )
      : 0;
    const projectionWindowMinutes =
      timeRangeMinutes !== null && timeRangeMinutes > 0 ? timeRangeMinutes : actualSpanMinutes;
    const percentPerMinute =
      estimatedPercent > 0 && projectionWindowMinutes > 0
        ? estimatedPercent / projectionWindowMinutes
        : null;
    const latestCalibration =
      matchedCalibrations.length > 0
        ? matchedCalibrations.reduce((latest, calibration) =>
            latest.timestampMs <= calibration.timestampMs ? calibration : latest
          )
        : null;
    const liveWindow = latestCalibration
      ? liveUsageWindows.get(calibrationKey(latestCalibration))
      : null;
    const resetAtMs = liveWindow?.resetAtMs ?? latestCalibration?.resetAtMs ?? null;
    const currentPercent = liveWindow?.currentPercent ?? latestCalibration?.currentPercent ?? null;
    const minutesUntilReset =
      resetAtMs !== null && now > 0 ? Math.max((resetAtMs - now) / 60000, 0) : null;
    const projectedRemainingAtReset =
      currentPercent !== null && percentPerMinute !== null && minutesUntilReset !== null
        ? 100 - (currentPercent + percentPerMinute * minutesUntilReset)
        : null;

    const denominator = windowMinutes > 0 ? windowMinutes : 1;
    return {
      tokenBreakdown: { cachedTokens, reasoningTokens },
      rateStats: {
        rpm: requestCount / denominator,
        tpm: tokenCount / denominator,
        windowMinutes,
        requestCount,
        tokenCount,
      },
      totalCost,
      latencyStats,
      usageProjection:
        estimatedPercent > 0
          ? {
              percent: estimatedPercent,
              percentPerMinute,
              projectedRemainingAtReset,
            }
          : null,
    };
  }, [
    hasPrices,
    liveUsageWindows,
    modelPrices,
    nowMs,
    sevenDayCalibrationIndex,
    timeRangeMinutes,
    usage,
  ]);

  const statsCards: StatCardData[] = [
    {
      key: 'requests',
      label: t('usage_stats.total_requests'),
      icon: <IconSatellite size={16} />,
      accent: '#8b8680',
      accentSoft: 'rgba(139, 134, 128, 0.18)',
      accentBorder: 'rgba(139, 134, 128, 0.35)',
      value: loading ? '-' : (usage?.total_requests ?? 0).toLocaleString(),
      meta: (
        <>
          <span className={styles.statMetaItem}>
            <span className={styles.statMetaDot} style={{ backgroundColor: '#10b981' }} />
            {t('usage_stats.success_requests')}: {loading ? '-' : (usage?.success_count ?? 0)}
          </span>
          <span className={styles.statMetaItem}>
            <span className={styles.statMetaDot} style={{ backgroundColor: '#c65746' }} />
            {t('usage_stats.failed_requests')}: {loading ? '-' : (usage?.failure_count ?? 0)}
          </span>
          {latencyStats.sampleCount > 0 && (
            <span className={styles.statMetaItem} title={latencyHint}>
              {t('usage_stats.avg_time')}:{' '}
              {loading ? '-' : formatDurationMs(latencyStats.averageMs)}
            </span>
          )}
        </>
      ),
      trend: sparklines.requests,
    },
    {
      key: 'tokens',
      label: t('usage_stats.total_tokens'),
      icon: <IconDiamond size={16} />,
      accent: '#8b5cf6',
      accentSoft: 'rgba(139, 92, 246, 0.18)',
      accentBorder: 'rgba(139, 92, 246, 0.35)',
      value: loading ? '-' : formatCompactNumber(usage?.total_tokens ?? 0),
      meta: (
        <>
          <span className={styles.statMetaItem}>
            {t('usage_stats.cached_tokens')}:{' '}
            {loading ? '-' : formatCompactNumber(tokenBreakdown.cachedTokens)}
          </span>
          <span className={styles.statMetaItem}>
            {t('usage_stats.reasoning_tokens')}:{' '}
            {loading ? '-' : formatCompactNumber(tokenBreakdown.reasoningTokens)}
          </span>
        </>
      ),
      trend: sparklines.tokens,
    },
    {
      key: 'rpm',
      label: t('usage_stats.rpm_30m'),
      icon: <IconTimer size={16} />,
      accent: '#22c55e',
      accentSoft: 'rgba(34, 197, 94, 0.18)',
      accentBorder: 'rgba(34, 197, 94, 0.32)',
      value: loading ? '-' : formatPerMinuteValue(rateStats.rpm),
      meta: (
        <span className={styles.statMetaItem}>
          {t('usage_stats.total_requests')}:{' '}
          {loading ? '-' : rateStats.requestCount.toLocaleString()}
        </span>
      ),
      trend: sparklines.rpm,
    },
    {
      key: 'tpm',
      label: t('usage_stats.tpm_30m'),
      icon: <IconTrendingUp size={16} />,
      accent: '#f97316',
      accentSoft: 'rgba(249, 115, 22, 0.18)',
      accentBorder: 'rgba(249, 115, 22, 0.32)',
      value: loading ? '-' : formatPerMinuteValue(rateStats.tpm),
      meta: (
        <span className={styles.statMetaItem}>
          {t('usage_stats.total_tokens')}:{' '}
          {loading ? '-' : formatCompactNumber(rateStats.tokenCount)}
        </span>
      ),
      trend: sparklines.tpm,
    },
    {
      key: 'cost',
      label: t('usage_stats.total_cost'),
      icon: <IconDollarSign size={16} />,
      accent: '#f59e0b',
      accentSoft: 'rgba(245, 158, 11, 0.18)',
      accentBorder: 'rgba(245, 158, 11, 0.32)',
      value: loading ? '-' : hasPrices ? formatUsd(totalCost) : '--',
      meta: (
        <>
          <span className={styles.statMetaItem}>
            {t('usage_stats.total_tokens')}:{' '}
            {loading ? '-' : formatCompactNumber(usage?.total_tokens ?? 0)}
          </span>
          {usageProjection && (
            <span className={styles.statMetaItem}>
              {t('usage_stats.estimated_7d_usage')}:{' '}
              {loading ? '-' : formatPercent(usageProjection.percent)}
            </span>
          )}
          {usageProjection && usageProjection.percentPerMinute !== null && (
            <span className={styles.statMetaItem}>
              {t('usage_stats.usage_per_minute')}:{' '}
              {loading ? '-' : formatPercent(usageProjection.percentPerMinute, 4)}
            </span>
          )}
          {usageProjection && usageProjection.projectedRemainingAtReset !== null && (
            <span
              className={`${styles.statMetaItem} ${
                usageProjection.projectedRemainingAtReset >= 0
                  ? styles.statProjectionGood
                  : styles.statProjectionBad
              }`}
            >
              {t('usage_stats.projected_reset_margin')}:{' '}
              {loading
                ? '-'
                : `${usageProjection.projectedRemainingAtReset >= 0 ? '+' : ''}${formatPercent(
                    usageProjection.projectedRemainingAtReset,
                    1
                  )}`}
            </span>
          )}
          {!hasPrices && (
            <span className={`${styles.statMetaItem} ${styles.statSubtle}`}>
              {t('usage_stats.cost_need_price')}
            </span>
          )}
        </>
      ),
      trend: hasPrices ? sparklines.cost : null,
    },
  ];

  return (
    <div className={styles.statsGrid}>
      {statsCards.map((card) => (
        <div
          key={card.key}
          className={styles.statCard}
          style={
            {
              '--accent': card.accent,
              '--accent-soft': card.accentSoft,
              '--accent-border': card.accentBorder,
            } as CSSProperties
          }
        >
          <div className={styles.statCardHeader}>
            <div className={styles.statLabelGroup}>
              <span className={styles.statLabel}>{card.label}</span>
            </div>
            <span className={styles.statIconBadge}>{card.icon}</span>
          </div>
          <div className={styles.statValue}>{card.value}</div>
          {card.meta && <div className={styles.statMetaRow}>{card.meta}</div>}
          <div className={styles.statTrend}>
            {card.trend ? (
              <Line
                className={styles.sparkline}
                data={card.trend.data}
                options={sparklineOptions}
              />
            ) : (
              <div className={styles.statTrendPlaceholder}></div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
