import { Autowired } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-browser';

import { ResourceService } from '../../common';
import { BrowserEditorContribution, EditorComponentRegistry, EditorOpenType } from '../types';

import { MergeEditorResourceProvider } from './merge-editor.provider';

@Domain(BrowserEditorContribution)
export class MergeEditorContribution implements BrowserEditorContribution {
  @Autowired()
  private readonly mergeEditorResourceProvider: MergeEditorResourceProvider;

  registerResource(resourceService: ResourceService): void {
    resourceService.registerResourceProvider(this.mergeEditorResourceProvider);
  }

  registerEditorComponent(registry: EditorComponentRegistry) {
    registry.registerEditorComponentResolver('mergeEditor', (_, results) => {
      results.push({
        type: EditorOpenType.mergeEditor,
      });
    });
  }
}
