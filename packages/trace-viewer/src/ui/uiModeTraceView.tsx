/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { artifactsFolderName } from '@testIsomorphic/folders';
import type { TreeItem } from '@testIsomorphic/testTree';
import type { ActionTraceEvent } from '@trace/trace';
import '@web/common.css';
import '@web/third_party/vscode/codicon.css';
import type * as reporterTypes from 'playwright/types/testReporter';
import React from 'react';
import type { ContextEntry } from '../entries';
import type { SourceLocation } from './modelUtil';
import { idForAction, MultiTraceModel } from './modelUtil';
import { Workbench } from './workbench';
import { type Setting } from '@web/uiUtils';

export const TraceView: React.FC<{
  showRouteActionsSetting: Setting<boolean>,
  item: { treeItem?: TreeItem, testFile?: SourceLocation, testCase?: reporterTypes.TestCase },
  rootDir?: string,
}> = ({ showRouteActionsSetting, item, rootDir }) => {
  const [model, setModel] = React.useState<{ model: MultiTraceModel, isLive: boolean } | undefined>();
  const [counter, setCounter] = React.useState(0);
  const pollTimer = React.useRef<NodeJS.Timeout | null>(null);

  const { outputDir } = React.useMemo(() => {
    const outputDir = item.testCase ? outputDirForTestCase(item.testCase) : undefined;
    return { outputDir };
  }, [item]);

  // Preserve user selection upon live-reloading trace model by persisting the action id.
  // This avoids auto-selection of the last action every time we reload the model.
  const [selectedActionId, setSelectedActionId] = React.useState<string | undefined>();
  const onSelectionChanged = React.useCallback((action: ActionTraceEvent) => setSelectedActionId(idForAction(action)), [setSelectedActionId]);
  const initialSelection = selectedActionId ? model?.model.actions.find(a => idForAction(a) === selectedActionId) : undefined;

  React.useEffect(() => {
    if (pollTimer.current)
      clearTimeout(pollTimer.current);

    const result = item.testCase?.results[0];
    if (!result) {
      setModel(undefined);
      return;
    }

    // Test finished.
    const attachment = result && result.duration >= 0 && result.attachments.find(a => a.name === 'trace');
    if (attachment && attachment.path) {
      loadSingleTraceFile(attachment.path).then(model => setModel({ model, isLive: false }));
      return;
    }

    if (!outputDir) {
      setModel(undefined);
      return;
    }

    const traceLocation = `${outputDir}/${artifactsFolderName(result!.workerIndex)}/traces/${item.testCase?.id}.json`;
    // Start polling running test.
    pollTimer.current = setTimeout(async () => {
      try {
        const model = await loadSingleTraceFile(traceLocation);
        setModel({ model, isLive: true });
      } catch {
        setModel(undefined);
      } finally {
        setCounter(counter + 1);
      }
    }, 500);
    return () => {
      if (pollTimer.current)
        clearTimeout(pollTimer.current);
    };
  }, [outputDir, item, setModel, counter, setCounter]);

  return <Workbench
    key='workbench'
    showRouteActionsSetting={showRouteActionsSetting}
    model={model?.model}
    showSourcesFirst={true}
    rootDir={rootDir}
    initialSelection={initialSelection}
    onSelectionChanged={onSelectionChanged}
    fallbackLocation={item.testFile}
    isLive={model?.isLive}
    status={item.treeItem?.status} />;
};

const outputDirForTestCase = (testCase: reporterTypes.TestCase): string | undefined => {
  for (let suite: reporterTypes.Suite | undefined = testCase.parent; suite; suite = suite.parent) {
    if (suite.project())
      return suite.project()?.outputDir;
  }
  return undefined;
};

async function loadSingleTraceFile(url: string): Promise<MultiTraceModel> {
  const params = new URLSearchParams();
  params.set('trace', url);
  const response = await fetch(`contexts?${params.toString()}`);
  const contextEntries = await response.json() as ContextEntry[];
  return new MultiTraceModel(contextEntries);
}
