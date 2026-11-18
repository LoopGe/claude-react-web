// imageBlockToDataUrl / imageDataUrl moved to shared/image-block.ts so the
// server search index and the client renderer share one image-source reader.
// Re-exported here so every existing import site keeps compiling.
export { imageBlockToDataUrl, imageDataUrl } from '../../shared/image-block'
