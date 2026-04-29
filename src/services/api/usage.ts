/**
 * 使用统计相关 API
 */

import { apiClient } from './client';
import { computeKeyStats, KeyStats } from '@/utils/usage';
import type { AuthFileItem } from '@/types';

const USAGE_TIMEOUT_MS = 60 * 1000;

export interface UsageExportPayload {
  version?: number;
  exported_at?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UsageImportResponse {
  added?: number;
  skipped?: number;
  total_requests?: number;
  failed_requests?: number;
  [key: string]: unknown;
}

export interface UsagePercentCalibrationSession {
  provider?: string;
  model?: string;
  auth_id?: string;
  auth_index?: string;
  app?: string;
  started_at?: string;
  start_percent?: number;
  start_five_hour_percent?: number;
  start_weekly_percent?: number;
  start_tokens?: number;
  start_score?: number;
  token_kind?: string;
  target_score?: number;
  max_duration_seconds?: number;
  current_tokens?: number;
  sample_tokens?: number;
  current_score?: number;
  sample_score?: number;
}

export interface UsagePercentCalibration {
  provider?: string;
  model?: string;
  auth_id?: string;
  auth_index?: string;
  app?: string;
  token_kind?: string;
  tokens_per_percent?: number;
  five_hour_tokens_per_percent?: number;
  weekly_tokens_per_percent?: number;
  five_hour_total_tokens?: number;
  weekly_total_tokens?: number;
  sample_tokens?: number;
  sample_score?: number;
  five_hour_sample_percent?: number;
  weekly_sample_percent?: number;
  recorded_at?: string;
}

export interface UsagePercentCalibrationState {
  active?: UsagePercentCalibrationSession;
  calibrations?: UsagePercentCalibration[];
}

export interface UsagePercentCalibrationAutomaticModel {
  id?: string;
  name?: string;
  model?: string;
  display_name?: string;
  type?: string;
  owned_by?: string;
  [key: string]: unknown;
}

export interface UsagePercentCalibrationAutomaticCandidate {
  auth_file?: AuthFileItem;
  models?: UsagePercentCalibrationAutomaticModel[];
}

export interface UsagePercentCalibrationAutomaticActive extends UsagePercentCalibrationSession {
  current_tokens?: number;
  sample_tokens?: number;
  remaining_tokens?: number;
  sample_border_tokens?: number;
  ready?: boolean;
  current_score?: number;
  sample_score?: number;
  score_formula?: string;
}

export interface UsagePercentCalibrationAutomaticState {
  sample_border_tokens?: number;
  score_formula?: string;
  candidates?: UsagePercentCalibrationAutomaticCandidate[];
  active?: UsagePercentCalibrationAutomaticActive;
  calibrations?: UsagePercentCalibration[];
}

export interface StartUsagePercentCalibrationPayload {
  provider: string;
  model: string;
  auth_id?: string;
  auth_index?: string;
  app?: string;
  current_percent: number;
  current_five_hour_percent?: number;
  current_weekly_percent?: number;
  token_kind?: string;
  target_score?: number;
  max_duration_seconds?: number;
}

export interface StopUsagePercentCalibrationPayload {
  current_percent: number;
  current_five_hour_percent?: number;
  current_weekly_percent?: number;
}

export interface StartUsagePercentCalibrationAutomaticPayload {
  name?: string;
  auth_id?: string;
  auth_index?: string;
  model: string;
  app?: string;
  current_percent: number;
  current_five_hour_percent?: number;
  current_weekly_percent?: number;
}

export interface UsagePercentCalibrationResponse {
  active?: UsagePercentCalibrationSession;
  calibration?: UsagePercentCalibration;
}

export interface UsagePercentCalibrationAutomaticResponse {
  active?: UsagePercentCalibrationAutomaticActive;
  calibration?: UsagePercentCalibration;
}

export const usageApi = {
  /**
   * 获取使用统计原始数据
   */
  getUsage: () => apiClient.get<Record<string, unknown>>('/usage', { timeout: USAGE_TIMEOUT_MS }),

  /**
   * 导出使用统计快照
   */
  exportUsage: () => apiClient.get<UsageExportPayload>('/usage/export', { timeout: USAGE_TIMEOUT_MS }),

  /**
   * 导入使用统计快照
   */
  importUsage: (payload: unknown) =>
    apiClient.post<UsageImportResponse>('/usage/import', payload, { timeout: USAGE_TIMEOUT_MS }),

  getPercentCalibration: () =>
    apiClient.get<UsagePercentCalibrationState>('/usage/percent-calibration', {
      timeout: USAGE_TIMEOUT_MS
    }),

  getPercentCalibrationAutomatic: () =>
    apiClient.get<UsagePercentCalibrationAutomaticState>('/usage/percent-calibration/automatic', {
      timeout: USAGE_TIMEOUT_MS
    }),

  startPercentCalibration: (payload: StartUsagePercentCalibrationPayload) =>
    apiClient.post<UsagePercentCalibrationResponse>('/usage/percent-calibration/start', payload, {
      timeout: USAGE_TIMEOUT_MS
    }),

  stopPercentCalibration: (payload: StopUsagePercentCalibrationPayload) =>
    apiClient.post<UsagePercentCalibrationResponse>('/usage/percent-calibration/stop', payload, {
      timeout: USAGE_TIMEOUT_MS
    }),

  startPercentCalibrationAutomatic: (payload: StartUsagePercentCalibrationAutomaticPayload) =>
    apiClient.post<UsagePercentCalibrationAutomaticResponse>(
      '/usage/percent-calibration/automatic/start',
      payload,
      { timeout: USAGE_TIMEOUT_MS }
    ),

  stopPercentCalibrationAutomatic: (payload: StopUsagePercentCalibrationPayload) =>
    apiClient.post<UsagePercentCalibrationAutomaticResponse>(
      '/usage/percent-calibration/automatic/stop',
      payload,
      { timeout: USAGE_TIMEOUT_MS }
    ),

  cancelPercentCalibration: () =>
    apiClient.delete<{ ok?: boolean }>('/usage/percent-calibration/active', {
      timeout: USAGE_TIMEOUT_MS
    }),

  /**
   * 计算密钥成功/失败统计，必要时会先获取 usage 数据
   */
  async getKeyStats(usageData?: unknown): Promise<KeyStats> {
    let payload = usageData;
    if (!payload) {
      const response = await apiClient.get<Record<string, unknown>>('/usage', { timeout: USAGE_TIMEOUT_MS });
      payload = response?.usage ?? response;
    }
    return computeKeyStats(payload);
  }
};
