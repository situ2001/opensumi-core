import { Autowired, Injectable } from '@ali/common-di';
import {
  ClientAppContribution,
  URI,
  Domain,
  CommandContribution,
  CommandRegistry,
  COMMON_COMMANDS,
  KeybindingContribution,
  KeybindingRegistry,
  WithEventBus,
  MaybePromise,
  localize,
  MenuContribution,
  MenuModelRegistry,
  EDITOR_COMMANDS,
  CommandService,
} from '@ali/ide-core-browser';
import { IFileServiceClient } from '@ali/ide-file-service/lib/common';
import { BrowserEditorContribution, EditorComponentRegistry } from '@ali/ide-editor/lib/browser';
import { ResourceService, IResourceProvider, IResource } from '@ali/ide-editor';
import { KEYMAPS_SCHEME } from '../common';
import { SETTINGS_MENU_PATH } from '@ali/ide-activity-bar';
import { KeymapsView } from './keymaps.view';

const PREF_PREVIEW_COMPONENT_ID = 'pref-preview';

@Injectable()
export class KeymapsResourceProvider extends WithEventBus implements IResourceProvider {

  readonly scheme: string = KEYMAPS_SCHEME;

  constructor() {
    super();
  }

  provideResource(uri: URI): MaybePromise<IResource<any>> {
    return {
      name: localize('keymaps.titile'),
      icon: '',
      uri,
    };
  }

  provideResourceSubname(resource: IResource, groupResources: IResource[]): string | null {
    return null;
  }

  async shouldCloseResource(resource: IResource, openedResources: IResource[][]): Promise<boolean> {
    return true;
  }
}

export namespace KeymapsContextMenu {
  // 1_, 2_用于菜单排序，这样能保证分组顺序顺序
  export const KEYMAPS = [...SETTINGS_MENU_PATH, '2_keymaps'];
}

@Domain(CommandContribution, KeybindingContribution, ClientAppContribution, BrowserEditorContribution, MenuContribution)
export class KeymapsContribution implements CommandContribution, KeybindingContribution, ClientAppContribution, BrowserEditorContribution, MenuContribution {

  @Autowired(IFileServiceClient)
  protected readonly filesystem: IFileServiceClient;

  @Autowired(KeymapsResourceProvider)
  keymapsResourceProvider: KeymapsResourceProvider;

  @Autowired(CommandService)
  commandService: CommandService;

  registerCommands(commands: CommandRegistry) {
    commands.registerCommand(COMMON_COMMANDS.OPEN_KEYMAPS, {
      isEnabled: () => true,
      execute: async () => {
        await this.openKeyboard();
      },
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(KeymapsContextMenu.KEYMAPS, {
      commandId: COMMON_COMMANDS.OPEN_KEYMAPS.id,
    });
  }

  registerKeybindings(keybindings: KeybindingRegistry): void {
    keybindings.registerKeybinding({
      command: COMMON_COMMANDS.OPEN_KEYMAPS.id,
      keybinding: 'ctrlcmd+K ctrlcmd+S',
    });
  }

  onStart() {

  }

  initialize(): void {
  }

  protected async openKeyboard(): Promise<void> {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, new URI().withScheme(KEYMAPS_SCHEME));
  }

  registerResource(resourceService: ResourceService) {
    resourceService.registerResourceProvider(this.keymapsResourceProvider);
  }

  registerEditorComponent(editorComponentRegistry: EditorComponentRegistry) {

    editorComponentRegistry.registerEditorComponent({
      component: KeymapsView,
      uid: PREF_PREVIEW_COMPONENT_ID,
      scheme: KEYMAPS_SCHEME,
    });

    editorComponentRegistry.registerEditorComponentResolver(KEYMAPS_SCHEME, (_, __, resolve) => {

      resolve!([
        {
          type: 'component',
          componentId: PREF_PREVIEW_COMPONENT_ID,
        },
      ]);

    });
  }
}
