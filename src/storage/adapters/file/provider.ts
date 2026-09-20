import { resolve } from "node:path";
import type { StorageProviderFactory } from "../../config/provider.js";
import { FileBlobStore } from "./file-blob-store.js";

export const createStore: StorageProviderFactory = ({ environment }) =>
  new FileBlobStore(resolve(environment.STORAGE_FILE_DIRECTORY ?? ".data/web"));
