import type { StorageProviderFactory } from "../../config/provider.js";
import { InMemoryBlobStore } from "./in-memory-blob-store.js";

export const createStore: StorageProviderFactory = () => new InMemoryBlobStore();
