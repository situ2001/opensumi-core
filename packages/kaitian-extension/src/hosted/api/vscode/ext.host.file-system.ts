import type * as vscode from 'vscode';
import { IRPCProtocol } from '@ali/ide-connection';
import {
  FileChangeType,
  FileStat,
  FileSystemProviderCapabilities,
  FileChange,
} from '@ali/ide-file-service';
import {
  URI,
  IDisposable,
  Schemas,
  toDisposable,
} from '@ali/ide-core-common';
import {
  MainThreadAPIIdentifier,
} from '../../../common/vscode';
import * as files from '../../../common/vscode/file-system';
import { UriComponents } from '../../../common/vscode/ext-types';

export function convertToVSCFileStat(stat: FileStat): vscode.FileStat {
  return {
    type: stat.type || 0,
    ctime: stat.createTime || -1,
    mtime: stat.lastModification,
    size: stat.size || 0,
  };
}

class ConsumerFileSystem implements vscode.FileSystem {

  constructor(private _proxy: files.IMainThreadFileSystemShape) { }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this._proxy.$stat(uri).catch(ConsumerFileSystem._handleError);
  }
  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this._proxy.$readdir(uri).catch(ConsumerFileSystem._handleError);
  }
  createDirectory(uri: vscode.Uri): Promise<void> {
    return this._proxy.$mkdir(uri).catch(ConsumerFileSystem._handleError);
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this._proxy.$readFile(uri).then((content) => {
      return Buffer.from(content);
    }).catch(ConsumerFileSystem._handleError);
  }
  writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    return this._proxy.$writeFile(uri, content).catch(ConsumerFileSystem._handleError);
  }
  delete(uri: vscode.Uri, options?: { recursive?: boolean; useTrash?: boolean; }): Promise<void> {
    return this._proxy.$delete(uri, { ...{ recursive: false, useTrash: false }, ...options }).catch(ConsumerFileSystem._handleError);
  }
  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options?: { overwrite?: boolean; }): Promise<void> {
    return this._proxy.$rename(oldUri, newUri, { ...{ overwrite: false }, ...options }).catch(ConsumerFileSystem._handleError);
  }
  copy(source: vscode.Uri, destination: vscode.Uri, options?: { overwrite?: boolean }): Promise<void> {
    return this._proxy.$copy(source, destination, { ...{ overwrite: false }, ...options }).catch(ConsumerFileSystem._handleError);
  }
  private static _handleError(err: any): never {
    // generic error
    if (!(err instanceof Error)) {
      throw new files.FileSystemError(String(err));
    }

    // no provider (unknown scheme) error
    if (err.name === 'ENOPRO') {
      throw files.FileSystemError.Unavailable(err.message);
    }

    // file system error
    switch (err.name) {
      case files.FileSystemProviderErrorCode.FileExists: throw files.FileSystemError.FileExists(err.message);
      case files.FileSystemProviderErrorCode.FileNotFound: throw files.FileSystemError.FileNotFound(err.message);
      case files.FileSystemProviderErrorCode.FileNotADirectory: throw files.FileSystemError.FileNotADirectory(err.message);
      case files.FileSystemProviderErrorCode.FileIsADirectory: throw files.FileSystemError.FileIsADirectory(err.message);
      case files.FileSystemProviderErrorCode.NoPermissions: throw files.FileSystemError.NoPermissions(err.message);
      case files.FileSystemProviderErrorCode.Unavailable: throw files.FileSystemError.Unavailable(err.message);

      default: throw new files.FileSystemError(err.message, err.name as files.FileSystemProviderErrorCode);
    }
  }
}

export class ExtHostFileSystem implements files.IExtHostFileSystemShape {
  private readonly _proxy: files.IMainThreadFileSystemShape;
  private readonly _fsProvider = new Map<number, vscode.FileSystemProvider>();
  private readonly _usedSchemes = new Set<string>();
  private readonly _watches = new Map<number, IDisposable>();

  private _handlePool: number = 0;

  readonly fileSystem: vscode.FileSystem;

  constructor(private readonly rpcProtocol: IRPCProtocol) {
    this._proxy = this.rpcProtocol.getProxy(MainThreadAPIIdentifier.MainThreadFileSystem);
    this.fileSystem = new ConsumerFileSystem(this._proxy);

    // register used schemes
    Object.keys(Schemas).forEach((scheme) => this._usedSchemes.add(scheme));
  }

  registerFileSystemProvider(scheme: string, provider: vscode.FileSystemProvider, options: { isCaseSensitive?: boolean, isReadonly?: boolean } = {}) {

    if (this._usedSchemes.has(scheme)) {
      throw new Error(`a provider for the scheme '${scheme}' is already registered`);
    }

    const handle = this._handlePool++;
    this._usedSchemes.add(scheme);
    this._fsProvider.set(handle, provider);

    let capabilities = FileSystemProviderCapabilities.FileReadWrite;
    if (options.isCaseSensitive) {
      capabilities += FileSystemProviderCapabilities.PathCaseSensitive;
    }
    if (options.isReadonly) {
      capabilities += FileSystemProviderCapabilities.Readonly;
    }
    if (typeof provider.copy === 'function') {
      capabilities += FileSystemProviderCapabilities.FileFolderCopy;
    }
    // TODO: proposed api
    // if (typeof provider.open === 'function' && typeof provider.close === 'function'
    // 	&& typeof provider.read === 'function' && typeof provider.write === 'function'
    // ) {
    // 	capabilities += FileSystemProviderCapabilities.FileOpenReadWriteClose;
    // }

    this._proxy.$registerFileSystemProvider(handle, scheme, capabilities);

    const subscription = provider.onDidChangeFile((event) => {
      const mapped: FileChange[] = [];
      for (const e of event) {
        const { uri, type } = e;
        if (uri.scheme !== scheme) {
          // dropping events for wrong scheme
          continue;
        }
        let newType: FileChangeType | undefined;
        switch (type) {
          case files.FileChangeType.Changed:
            newType = FileChangeType.UPDATED;
            break;
          case files.FileChangeType.Created:
            newType = FileChangeType.ADDED;
            break;
          case files.FileChangeType.Deleted:
            newType = FileChangeType.DELETED;
            break;
          default:
            throw new Error('Unknown FileChangeType');
        }
        mapped.push({ uri: uri.toString(), type: newType });
      }
      this._proxy.$onFileSystemChange(handle, mapped);
    });

    return toDisposable(() => {
      subscription.dispose();
      this._usedSchemes.delete(scheme);
      this._fsProvider.delete(handle);
      this._proxy.$unregisterProvider(handle);
    });
  }

  private static _asIStat(stat: vscode.FileStat): files.FileStat {
    const { type, ctime, mtime, size } = stat;
    return { type, ctime, mtime, size };
  }

  $stat(handle: number, resource: UriComponents): Promise<files.FileStat> {
    return Promise.resolve(this._getFsProvider(handle).stat(URI.revive(resource))).then(ExtHostFileSystem._asIStat);
  }

  $readdir(handle: number, resource: UriComponents): Promise<[string, files.FileType][]> {
    return Promise.resolve(this._getFsProvider(handle).readDirectory(URI.revive(resource)));
  }

  $readFile(handle: number, resource: UriComponents): Promise<Uint8Array> {
    return Promise.resolve(this._getFsProvider(handle).readFile(URI.revive(resource))).then((data) => data);
  }

  $writeFile(handle: number, resource: UriComponents, content: Uint8Array, opts: files.FileWriteOptions): Promise<void> {
    return Promise.resolve(this._getFsProvider(handle).writeFile(URI.revive(resource), content, opts));
  }

  $delete(handle: number, resource: UriComponents, opts: files.FileDeleteOptions): Promise<void> {
    return Promise.resolve(this._getFsProvider(handle).delete(URI.revive(resource), opts));
  }

  $rename(handle: number, oldUri: UriComponents, newUri: UriComponents, opts: files.FileOverwriteOptions): Promise<void> {
    return Promise.resolve(this._getFsProvider(handle).rename(URI.revive(oldUri), URI.revive(newUri), opts));
  }

  $copy(handle: number, oldUri: UriComponents, newUri: UriComponents, opts: files.FileOverwriteOptions): Promise<void> {
    const provider = this._getFsProvider(handle);
    if (!provider.copy) {
      throw new Error('FileSystemProvider does not implement "copy"');
    }
    return Promise.resolve(provider.copy(URI.revive(oldUri), URI.revive(newUri), opts));
  }

  $mkdir(handle: number, resource: UriComponents): Promise<void> {
    return Promise.resolve(this._getFsProvider(handle).createDirectory(URI.revive(resource)));
  }

  $watch(handle: number, session: number, resource: UriComponents, opts: files.IWatchOptions): void {
    const subscription = this._getFsProvider(handle).watch(URI.revive(resource), opts);
    this._watches.set(session, subscription);
  }

  $unwatch(_handle: number, session: number): void {
    const subscription = this._watches.get(session);
    if (subscription) {
      subscription.dispose();
      this._watches.delete(session);
    }
  }

  private _getFsProvider(handle: number): vscode.FileSystemProvider {
    const provider = this._fsProvider.get(handle);
    if (!provider) {
      const err = new Error();
      err.name = 'ENOPRO';
      err.message = `no provider`;
      throw err;
    }
    return provider;
  }
}
