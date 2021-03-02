
import { Injectable, Autowired, INJECTOR_TOKEN, Injector } from '@ali/common-di';
import { Event, Emitter, Uri, getDebugLogger } from '@ali/ide-core-common';
import {
  IDiskFileProvider, FileChangeEvent, FileStat,
  DiskFileServicePath, FileSystemProvider, FileType,
  DidFilesChangedParams, FileChange,
} from '../common';

export abstract class CoreFileServiceProviderClient implements FileSystemProvider {

  @Autowired(INJECTOR_TOKEN)
  injector: Injector;

  abstract fileServiceProvider: FileSystemProvider;

  protected readonly onDidChangeFileEmitter = new Emitter<FileChangeEvent>();
  onDidChangeFile: Event<FileChangeEvent> = this.onDidChangeFileEmitter.event;

  watch(uri: Uri, options: { recursive: boolean; excludes: string[]; }) {
    return this.fileServiceProvider.watch(uri, options);
  }
  unwatch(watcherId: number) {
    return this.fileServiceProvider.unwatch && this.fileServiceProvider.unwatch(watcherId);
  }
  async stat(uri: Uri): Promise<FileStat> {
    const stat = await this.fileServiceProvider.stat(uri);
    return stat;
  }
  readDirectory(uri: Uri): [string, FileType][] | Thenable<[string, FileType][]> {
    return this.fileServiceProvider.readDirectory(uri);
  }
  createDirectory(uri: Uri): void | Thenable<void | FileStat> {
    return this.fileServiceProvider.createDirectory(uri);
  }
  async readFile(uri: Uri, encoding?: string): Promise<Uint8Array> {
    if (encoding) {
      getDebugLogger('fileService.fsProvider').warn('encoding option for fsProvider.readFile is deprecated');
    }
    const buffer = await this.fileServiceProvider.readFile(uri);
    return buffer;
  }
  writeFile(uri: Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): void | Thenable<void | FileStat> {
    // TODO: 转换放到connection抹平
    return this.fileServiceProvider.writeFile(uri, Array.from(content) as any, options);
  }
  delete(uri: Uri, options: { recursive: boolean; moveToTrash?: boolean | undefined; }): void | Thenable<void> {
    return this.fileServiceProvider.delete(uri, options);
  }
  rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean; }): void | Thenable<void | FileStat> {
    return this.fileServiceProvider.rename(oldUri, newUri, options);
  }
}

@Injectable()
export class DiskFsProviderClient extends CoreFileServiceProviderClient implements IDiskFileProvider {
  @Autowired(DiskFileServicePath)
  fileServiceProvider: IDiskFileProvider;

  setWatchFileExcludes(excludes: string[]) {
    return this.fileServiceProvider.setWatchFileExcludes(excludes);
  }

  getWatchFileExcludes() {
    return this.fileServiceProvider.getWatchFileExcludes();
  }

  onDidFilesChanged(event: DidFilesChangedParams): void {
    const changes: FileChange[] = event.changes.map((change) => {
      return {
        uri: change.uri,
        type: change.type,
      } as FileChange;
    });
    this.onDidChangeFileEmitter.fire(changes);
  }

  copy(source: Uri, destination: Uri, options: { overwrite: boolean }) {
    return this.fileServiceProvider.copy(source, destination, options);
  }

  access(uri: Uri, mode) {
    return this.fileServiceProvider.access(uri, mode);
  }

  getCurrentUserHome() {
    return this.fileServiceProvider.getCurrentUserHome();
  }

  getFileType(uri: string) {
    return this.fileServiceProvider.getFileType(uri);
  }
}
