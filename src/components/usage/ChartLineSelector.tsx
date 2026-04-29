import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import styles from '@/pages/UsagePage.module.scss';

export interface ChartLineSelectorProps {
  chartLines: string[];
  modelNames: string[];
  maxLines?: number;
  onChange: (lines: string[]) => void;
}

export function ChartLineSelector({
  chartLines,
  modelNames,
  maxLines = 9,
  onChange
}: ChartLineSelectorProps) {
  const { t } = useTranslation();
  const selectedModelLines = useMemo(
    () => chartLines.filter((line) => line !== 'all'),
    [chartLines]
  );
  const unusedModel = useMemo(
    () => modelNames.find((modelName) => !selectedModelLines.includes(modelName)),
    [modelNames, selectedModelLines]
  );
  const canAdd = chartLines.length < maxLines && Boolean(unusedModel);

  const handleAdd = () => {
    if (!canAdd) return;
    if (unusedModel) {
      onChange([...selectedModelLines, unusedModel]);
    }
  };

  const handleRemove = (index: number) => {
    if (chartLines.length <= 1) return;
    const newLines = [...chartLines];
    newLines.splice(index, 1);
    onChange(newLines);
  };

  const handleChange = (index: number, value: string) => {
    if (value === 'all') {
      onChange(['all']);
      return;
    }

    const newLines = chartLines
      .map((line, lineIndex) => (lineIndex === index ? value : line))
      .filter((line) => line !== 'all')
      .filter((line, lineIndex, lines) => lines.indexOf(line) === lineIndex);

    onChange(newLines.length ? newLines : ['all']);
  };

  const options = useMemo(
    () => [
      { value: 'all', label: t('usage_stats.chart_line_all') },
      ...modelNames.map((name) => ({ value: name, label: name }))
    ],
    [modelNames, t]
  );

  return (
    <Card
      title={t('usage_stats.chart_line_actions_label')}
      extra={
        <div className={styles.chartLineHeader}>
          <span className={styles.chartLineCount}>
            {chartLines.length}/{maxLines}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleAdd}
            disabled={!canAdd}
          >
            {t('usage_stats.chart_line_add')}
          </Button>
        </div>
      }
    >
      <div className={styles.chartLineList}>
        {chartLines.map((line, index) => (
          <div key={index} className={styles.chartLineItem}>
            <span className={styles.chartLineLabel}>
              {t(`usage_stats.chart_line_label_${index + 1}`)}
            </span>
            <Select
              value={line}
              options={options}
              onChange={(value) => handleChange(index, value)}
            />
            {chartLines.length > 1 && (
              <Button variant="danger" size="sm" onClick={() => handleRemove(index)}>
                {t('usage_stats.chart_line_delete')}
              </Button>
            )}
          </div>
        ))}
      </div>
      <p className={styles.chartLineHint}>{t('usage_stats.chart_line_hint')}</p>
    </Card>
  );
}
