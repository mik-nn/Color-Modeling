import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock File API for testing
// The global File class in jsdom doesn't have the text() method by default
if (typeof File !== 'undefined') {
  const OriginalFile = File
  
  // Ensure File.prototype.text exists
  if (!File.prototype.text) {
    File.prototype.text = function() {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error)
        reader.readAsText(this)
      })
    }
  }
}

// Mock Blob.prototype.text if missing (for older jsdom versions)
if (typeof Blob !== 'undefined' && !Blob.prototype.text) {
  Blob.prototype.text = function() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsText(this)
    })
  }
}
