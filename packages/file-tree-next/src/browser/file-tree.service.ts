import { Injectable, Autowired } from '@ali/common-di';
import {
  CommandService,
  IContextKeyService,
  URI,
  EDITOR_COMMANDS,
  Disposable,
  FILE_COMMANDS,
} from '@ali/ide-core-browser';
import { CorePreferences } from '@ali/ide-core-browser/lib/core-preferences';
import { IFileTreeAPI } from '../common';
import { FileChange, IFileServiceClient, FileChangeType, FileStat, IFileServiceWatcher } from '@ali/ide-file-service/lib/common';
import { IWorkspaceService } from '@ali/ide-workspace';
import { Tree, ITree, WatchEvent, ITreeNodeOrCompositeTreeNode, IWatcherEvent, TreeNodeType } from '@ali/ide-components';
import { Directory, File } from './file-tree-nodes';
import { FileTreeDecorationService } from './services/file-tree-decoration.service';
import { LabelService } from '@ali/ide-core-browser/lib/services';
import { Path } from '@ali/ide-core-common/lib/path';
import { observable, action, runInAction } from 'mobx';
import pSeries = require('p-series');
import { FileContextKey } from './file-contextkey';

export interface IMoveChange {
  source: FileChange;
  target: FileChange;
}

@Injectable()
export class FileTreeService extends Tree {

  @Autowired(IFileTreeAPI)
  private readonly fileTreeAPI: IFileTreeAPI;

  @Autowired(CommandService)
  private readonly commandService: CommandService;

  @Autowired(IContextKeyService)
  private readonly contextKeyService: IContextKeyService;

  @Autowired(IWorkspaceService)
  private readonly workspaceService: IWorkspaceService;

  @Autowired(CorePreferences)
  private readonly corePreferences: CorePreferences;

  @Autowired(LabelService)
  public readonly labelService: LabelService;

  @Autowired(FileTreeDecorationService)
  public readonly decorationService: FileTreeDecorationService;

  @Autowired(IFileServiceClient)
  private readonly fileServiceClient: IFileServiceClient;

  @Autowired(FileContextKey)
  private readonly fileTreeContextKey: FileContextKey;

  private _contextMenuContextKeyService: IContextKeyService;

  private _cacheNodesMap: Map<string, File | Directory> = new Map();

  private _fileServiceWatchers: Map<string, IFileServiceWatcher> = new Map();

  // 用于记录文件系统Change事件的定时器
  private eventFlushTimeout: number;
  // 文件系统Change事件队列
  private changeEventDispatchQueue: string[] = [];

  private roots: FileStat[] | null;

  @observable
  // 筛选模式开关
  filterMode: boolean = false;

  @observable
  baseIndent: number;

  @observable
  indent: number;

  get cacheFiles() {
    return Array.from(this._cacheNodesMap.values());
  }

  async init() {
    this.roots = await this.workspaceService.roots;

    this.baseIndent = this.corePreferences['explorer.fileTree.baseIndent'] || 8;
    this.indent = this.corePreferences['explorer.fileTree.indent'] || 8;

    this.toDispose.push(this.workspaceService.onWorkspaceChanged(async () => {
      this.dispose();
      this.roots = await this.workspaceService.roots;
      // TODO: 切换工作区时更新文件树
    }));

    this.toDispose.push(Disposable.create(() => {
      this._cacheNodesMap.clear();
      this.roots = null;
    }));

    this.toDispose.push(this.corePreferences.onPreferenceChanged((change) => {
      if (change.preferenceName === 'explorer.fileTree.baseIndent') {
        runInAction(() => {
          this.baseIndent = change.newValue as number || 8;
        });
      } else if (change.preferenceName === 'explorer.fileTree.indent') {
        runInAction(() => {
          this.indent = change.newValue as number || 8;
        });
      } else if (change.preferenceName === 'explorer.compactFolders') {
        this.refresh();
      }
    }));
  }

  async resolveChildren(parent?: Directory) {
    const isCompactFoldersModel = this.corePreferences['explorer.compactFolders'];
    let children: (File | Directory)[] = [];
    if (!parent) {
      // 加载根目录
      if (!this.roots) {
        this.roots = await this.workspaceService.roots;
      }
      if (this.isMutiWorkspace) {
        const rootUri = new URI(this.workspaceService.workspace?.uri);
        let rootName = rootUri.displayName;
        rootName = rootName.slice(0, rootName.lastIndexOf('.'));
        const fileStat = {
          ...this.workspaceService.workspace,
          isDirectory: true,
        } as FileStat;
        const root = new Directory(this as ITree, undefined, rootUri, rootName, fileStat, this.fileTreeAPI.getReadableTooltip(rootUri));
        // 创建Root节点并引入root文件目录
        this.cacheNodes([root]);
        this.root = root;
        return [root];
      } else {
        if (this.roots.length > 0) {
          children = await (await this.fileTreeAPI.resolveChildren(this as ITree, this.roots[0])).children;
          this.watchFilesChange(new URI(this.roots[0].uri));
          this.cacheNodes(children as (File | Directory)[]);
          this.root = children[0] as Directory;
          return children;
        }
      }
    } else {
      // 根节点加载子节点
      if (Directory.isRoot(parent) && this.isMutiWorkspace) {
        // 加载根目录
        const roots = await this.workspaceService.roots;
        for (const fileStat of roots) {
          const child = this.fileTreeAPI.toNode(this as ITree, fileStat, parent);
          this.watchFilesChange(new URI(fileStat.uri));
          children = children.concat(child);
        }
        this.cacheNodes(children as (File | Directory)[]);
        return children;
      }
      // 加载子目录
      if (parent.uri) {
        const data =  await this.fileTreeAPI.resolveChildren(this as ITree, parent.uri.toString(), parent, isCompactFoldersModel);
        children = data.children;
        const childrenParentStat = data.filestat;
        if (children.length > 0) {
          this.cacheNodes(children as (File | Directory)[]);
        }
        // 需要排除软连接下的直接空目录折叠，否则会导致路径计算错误
        // 但软连接目录下的其他目录不受影响
        if (isCompactFoldersModel && !parent.filestat.isSymbolicLink) {
          const parentURI = new URI(childrenParentStat.uri);
          // 父节点已为压缩节点，说明此时为点击子路径模式，需要添加临时的子目录节点
          if ((parent as Directory).compacted) {
            parent.updateFileStat({
              ...parent.filestat,
              uri: parent.uri.toString(),
            });
            const presetName = childrenParentStat.uri.replace(parent.filestat.uri + Path.separator, '');
            const child = this.fileTreeAPI.toNode(this as ITree, childrenParentStat, parent, presetName);
            return [child];
          } else {
            const parentName = parent.uri.parent.relative(parentURI)?.toString();
            if (parentName && parentName !== parent.name) {
              parent.updateName(parentName);
              parent.updateURI(parentURI);
              parent.updateFileStat(childrenParentStat);
            }
          }
        }
        return children;
      }
    }
    return [];
  }

  async watchFilesChange(uri: URI) {
    const watcher = await this.fileServiceClient.watchFileChanges(uri);
    this.toDispose.push(watcher);
    this.toDispose.push(watcher.onFilesChanged((changes: FileChange[]) => {
      this.onFilesChanged(changes);
    }));
    this._fileServiceWatchers.set(uri.toString(), watcher);
  }

  private isContentFile(node: any | undefined) {
    return !!node && 'filestat' in node && !node.filestat.isDirectory;
  }

  private isFileStatNode(node: object | undefined) {
    return !!node && 'filestat' in node;
  }

  private isFileContentChanged(change: FileChange): boolean {
    return change.type === FileChangeType.UPDATED && this.isContentFile(this.getNodeByPathOrUri(change.uri));
  }

  private getAffectedUris(changes: FileChange[]): URI[] {
    const uris: URI[] = [];
    for (const change of changes) {
      const isFile = this.isFileContentChanged(change);
      if (!isFile) {
        uris.push(new URI(change.uri));
      }
    }
    return uris;
  }

  private isRootAffected(changes: FileChange[]): boolean {
    const root = this.root;
    if (this.isFileStatNode(root)) {
      return changes.some((change) =>
        change.type < FileChangeType.DELETED && change.uri.toString() === (root as Directory)!.uri.toString(),
      );
    }
    return false;
  }

  private getDeletedUris(changes: FileChange[]): URI[] {
    return changes.filter((change) => change.type === FileChangeType.DELETED).map((change) => new URI(change.uri));
  }

  private getAddedUris(changes: FileChange[]): URI[] {
    return changes.filter((change) => change.type === FileChangeType.ADDED).map((change) => new URI(change.uri));
  }

  private getMoveChange(changes: FileChange[]) {
    changes = changes.slice(0);
    const moveChange: IMoveChange[] = [];
    const restChange = changes.filter((change) => change.type === FileChangeType.UPDATED);
    const deleteOrAddChanges = changes.filter((change) => change.type !== FileChangeType.UPDATED);
    while (deleteOrAddChanges.length >= 2) {
      const change = deleteOrAddChanges.shift();
      let target;
      let source;
      if (change?.type === FileChangeType.DELETED) {
        source = change;
        target = deleteOrAddChanges.find((change) => change.type === FileChangeType.ADDED && new URI(change.uri).displayName === new URI(source.uri).displayName);
        if (target) {
          deleteOrAddChanges.splice(deleteOrAddChanges.indexOf(target), 1);
          moveChange.push({source, target});
        }
      } else if (change?.type === FileChangeType.ADDED) {
        target = change;
        source = deleteOrAddChanges.find((change) => change.type === FileChangeType.DELETED && new URI(change.uri).displayName === new URI(target.uri).displayName);
        if (source) {
          deleteOrAddChanges.splice(deleteOrAddChanges.indexOf(source), 1);
          moveChange.push({source, target});
        }
      }
    }
    return {
      moveChange,
      restChange: restChange.concat(deleteOrAddChanges),
    };
  }

  private async onFilesChanged(changes: FileChange[]) {
    let restChange: FileChange[] = await this.moveAffectedNodes(changes);
    // 移除节点
    restChange = this.deleteAffectedNodes(this.getDeletedUris(restChange), restChange);
    // 添加节点, 需要获取节点类型
    restChange = await this.addAffectedNodes(this.getAddedUris(restChange), restChange);
    if (restChange.length === 0) {
      return ;
    }
    // 处理除了删除/添加/移动事件外的异常事件
    if (!await this.refreshAffectedNodes(this.getAffectedUris(restChange)) && this.isRootAffected(restChange)) {
      await this.refresh();
    }
  }

  private async moveAffectedNodes(changes: FileChange[]) {
    const data = this.getMoveChange(changes);
    const { moveChange, restChange } = data;

    for (const change of moveChange) {
      const node = this.getNodeByPathOrUri(new URI(change.source.uri).parent.toString());
      if (node) {
        await this.moveNode(node, change.source.uri, change.target.uri);
      }
    }
    return restChange;
  }

  public async getFileTreeNodePathByUri(uri: URI) {
    if (!uri) {
      return;
    }
    let rootStr;
    if (!this.isMutiWorkspace) {
      rootStr = this.workspaceService.workspace?.uri;
    } else {
      if (!this.roots) {
        this.roots = await this.workspaceService.roots;
      }
      rootStr = this.roots.find((root) => {
        return new URI(root.uri).isEqualOrParent(uri);
      })?.uri;
    }
    if (rootStr && this.root) {
      const rootUri = new URI(rootStr);
      if (rootUri.isEqualOrParent(uri)) {
        return new Path(this.root.path).join(rootUri.relative(uri)!.toString()).toString();
      }
      // 可能为当前工作区外的文件
    }
  }

  public async moveNode(node: File | Directory, source: string, target: string) {
    const oldPath = await this.getFileTreeNodePathByUri(new URI(source));
    const newPath = await this.getFileTreeNodePathByUri(new URI(target));
    if (oldPath && newPath && newPath !== oldPath) {
      this.dispatchWatchEvent(node!.path, { type: WatchEvent.Moved,  oldPath, newPath });
    }
  }

  // 软链接目录下，文件节点路径不能通过uri去获取，存在偏差
  public moveNodeByPath(node: File | Directory, oldPath: string, newPath: string) {
    if (oldPath && newPath && newPath !== oldPath) {
      this.dispatchWatchEvent(node!.path, { type: WatchEvent.Moved,  oldPath, newPath });
    }
  }

  public async addNode(node: Directory, newName: string, type: TreeNodeType) {
    const tempFileStat: FileStat = {
      uri: node.uri.resolve(newName).toString(),
      isDirectory: type === TreeNodeType.CompositeTreeNode,
      isSymbolicLink: false,
      lastModification: new Date().getTime(),
    };
    const addNode = await this.fileTreeAPI.toNode(this as ITree, tempFileStat, node as Directory);
    if (!!addNode) {
      this.cacheNodes([addNode]);
      // 节点创建失败时，不需要添加
      this.dispatchWatchEvent(node.path, { type: WatchEvent.Added,  node: addNode, id: node.id});
    }
    return addNode;
  }

  private async addAffectedNodes(uris: URI[], changes: FileChange[]) {
    const nodes: any[] = [];
    for (const uri of uris) {
      const parent = this.getNodeByPathOrUri(uri.parent.toString());
      if (!!parent) {
        nodes.push({
          parent,
          uri,
        });
      }
    }
    for (const node of nodes) {
      // 一旦更新队列中已包含该文件，临时剔除删除事件传递
      if (!node.parent || this.changeEventDispatchQueue.indexOf(node.parent.path) >= 0) {
        continue ;
      }
      const addNode = await this.fileTreeAPI.resolveNodeByPath(this as ITree, node.uri.toString(), node.parent as Directory);
      if (!!addNode) {
        this.cacheNodes([addNode]);
        // 节点创建失败时，不需要添加
        this.dispatchWatchEvent(node.parent.path, { type: WatchEvent.Added,  node: addNode, id: node.parent.id});
      }
    }
    return changes.filter((change) => change.type !== FileChangeType.ADDED);
  }

  // 用于精准删除节点，软连接目录下的文件删除
  public deleteAffectedNodeByPath(path: string) {
    const node  = this.getNodeByPathOrUri(path);
    if (node && node.parent) {
      this.removeNodeCacheByPath(node.path);
      this.dispatchWatchEvent(node.parent.path, { type: WatchEvent.Removed,  path: node.path });
    }
  }

  public deleteAffectedNodes(uris: URI[], changes: FileChange[] = []) {
    const nodes: File[] = [];
    for (const uri of uris) {
      const node = this.getNodeByPathOrUri(uri);
      if (!!node) {
        nodes.push(node as File);
      }
    }
    for (const node of nodes) {
      // 一旦更新队列中已包含该文件，临时剔除删除事件传递
      if (!node?.parent || this.changeEventDispatchQueue.indexOf(node?.parent.path) >= 0) {
        continue ;
      }
      this.removeNodeCacheByPath(node!.path);
      this.dispatchWatchEvent(node!.parent!.path, { type: WatchEvent.Removed,  path: node!.path });
    }
    return changes.filter((change) => change.type !== FileChangeType.DELETED);
  }

  private dispatchWatchEvent(path: string, event: IWatcherEvent) {
    const watcher = this.root?.watchEvents.get(path);
    if (watcher && watcher.callback) {
      watcher.callback(event);
    }
  }

  async refreshAffectedNodes(uris: URI[]) {
    const nodes = await this.getAffectedNodes(uris);
    for (const node of nodes) {
      await this.refresh(node);
    }
    return nodes.length !== 0;
  }

  private async getAffectedNodes(uris: URI[]): Promise<Directory[]> {
    const nodes: Directory[] = [];
    for (const uri of uris) {
      const node = this.getNodeByPathOrUri(uri.parent);
      if (node && Directory.is(node)) {
        nodes.push(node as Directory);
      } else {

      }
    }
    return nodes;
  }

  private cacheNodes(nodes: (File | Directory)[]) {
    // 切换工作区的时候需清理
    nodes.map((node) => {
      // node.path 不会重复，node.uri在软连接情况下可能会重复
      this._cacheNodesMap.set(node.path, node);
    });
  }

  private removeNodeCacheByPath(path: string) {
    if (this._cacheNodesMap.has(path)) {
      this._cacheNodesMap.delete(path);
    }
  }

  private isFileURI(str: string) {
    return /^file:\/\//.test(str);
  }

  getNodeByPathOrUri(pathOrUri: string | URI) {
    let path: string | undefined;
    let pathURI: URI | undefined;
    if (typeof pathOrUri === 'string' && !this.isFileURI(pathOrUri)) {
      return this._cacheNodesMap.get(pathOrUri);
    }
    if (typeof pathOrUri !== 'string') {
      pathURI = pathOrUri;
      pathOrUri = pathOrUri.toString();
    } else if (this.isFileURI(pathOrUri)) {
      pathURI = new URI(pathOrUri);
    }
    if (this.isFileURI(pathOrUri) && !!pathURI) {
      let rootStr;
      if (!this.isMutiWorkspace) {
        rootStr = this.workspaceService.workspace?.uri;
      } else if (!!this.roots) {
        rootStr = this.roots.find((root) => {
          return new URI(root.uri).isEqualOrParent(pathURI!);
        })?.uri;
      }
      if (this.root && rootStr) {
        const rootUri = new URI(rootStr);
        if (rootUri.isEqualOrParent(pathURI)) {
          path = new Path(this.root.path).join(rootUri.relative(pathURI)!.toString()).toString();
        }
      }
    }

    if (!!path) {
      return this._cacheNodesMap.get(path);
    }
  }

  sortComparator(a: ITreeNodeOrCompositeTreeNode, b: ITreeNodeOrCompositeTreeNode) {
    if (a.constructor === b.constructor) {
      // numeric 参数确保数字为第一排序优先级
      return a.name.localeCompare(b.name, 'kn', { numeric: true }) as any;
    }
    return a.type === TreeNodeType.CompositeTreeNode ? -1
      : b.type === TreeNodeType.CompositeTreeNode  ? 1
      : 0;
  }

  get contextMenuContextKeyService() {
    if (!this._contextMenuContextKeyService) {
      this._contextMenuContextKeyService = this.contextKeyService.createScoped();
    }
    return this._contextMenuContextKeyService;
  }

  public reWatch() {
    // 重连时重新监听文件变化
    for (const [uri, watcher] of this._fileServiceWatchers) {
      watcher.dispose();
      this.watchFilesChange(new URI(uri));
    }
  }

  get isMutiWorkspace(): boolean {
    return !!this.workspaceService.workspace && !this.workspaceService.workspace.isDirectory;
  }

  getDisplayName(uri: URI) {
    return this.workspaceService.getWorkspaceName(uri);
  }

  /**
   * 刷新指定下的所有子节点
   */
  async refresh(node: Directory = this.root as Directory) {
    if (!Directory.is(node) && node.parent) {
      node = node.parent as Directory;
    }
    this.queueChangeEvent(node.path, () => {
      this.onNodeRefreshedEmitter.fire(node);
    });
  }

  // 队列化Changed事件
  private queueChangeEvent(path: string, callback: any) {
    clearTimeout(this.eventFlushTimeout);
    this.eventFlushTimeout = setTimeout(async () => {
      await this.flushEventQueue();
      callback();
    }, 150) as any;
    if (this.changeEventDispatchQueue.indexOf(path) === -1) {
      this.changeEventDispatchQueue.push(path);
    }
  }

  public flushEventQueue = () => {
    let promise: Promise<any>;
    if (!this.changeEventDispatchQueue || this.changeEventDispatchQueue.length === 0) {
      return;
    }
    this.changeEventDispatchQueue.sort((pathA, pathB) => {
      const pathADepth = Path.pathDepth(pathA);
      const pathBDepth = Path.pathDepth(pathB);
      return pathADepth - pathBDepth;
    });
    promise = pSeries(this.changeEventDispatchQueue.map((path) => async () => {
      const watcher = this.root?.watchEvents.get(path);
      if (watcher && typeof watcher.callback === 'function') {
        await watcher.callback({ type: WatchEvent.Changed, path });
      }
      return null;
    }));
    // 重置更新队列
    this.changeEventDispatchQueue = [];
    return promise;
  }

  /**
   * 打开文件
   * @param uri
   */
  public openFile(uri: URI) {
    // 当打开模式为双击同时预览模式生效时，默认单击为预览文件
    const preview = this.corePreferences['editor.previewMode'];
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, { disableNavigate: true, preview });
  }

  /**
   * 打开并固定文件
   * @param uri
   */
  public openAndFixedFile(uri: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, { disableNavigate: true, preview: false });
  }

  /**
   * 在侧边栏打开文件
   * @param {URI} uri
   * @memberof FileTreeService
   */
  public openToTheSide(uri: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, { disableNavigate: true, split: 4 /** right */ });
  }

  /**
   * 比较选中的两个文件
   * @param original
   * @param modified
   */
  public compare(original: URI, modified: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.COMPARE.id, {
      original,
      modified,
    });
  }

  /**
   * 开关筛选输入框
   */
  @action.bound
  public toggleFilterMode() {
    this.filterMode = !this.filterMode;
    this.fileTreeContextKey.filesExplorerFilteredContext.set(this.filterMode);
    // 清理掉输入值
    if (this.filterMode === false) {
      // 退出时若需要做 filter 值清理则做聚焦操作
      this.commandService.executeCommand(FILE_COMMANDS.LOCATION.id);
    }
  }

  /**
   * 开启筛选模式
   */
  @action.bound
  public enableFilterMode() {
    this.fileTreeContextKey.filesExplorerFilteredContext.set(true);
    this.filterMode = true;
  }

  public locationToCurrentFile = () => {
    this.commandService.executeCommand(FILE_COMMANDS.LOCATION.id);
  }
}
