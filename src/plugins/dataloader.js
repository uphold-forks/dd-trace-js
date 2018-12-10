'use strict'

function createWrapLoad (tracer, config) {
  return function wrapLoad (original) {
    return function loadWithTrace (id) {
      const span = tracer.startSpan('dataloader')

      original.call(this, id).finally(() => { span.finish() })
    }
  }
}

module.exports = [
  {
    name: 'dataloader',
    versions: ['>= 1'],
    patch (Dataloader, tracer, config) {
      this.wrap(Dataloader.prototype, 'load', createWrapLoad(tracer, config))
    },
    unpatch (Dataloader) {
      this.unwrap(Promise.prototype, 'load')
    }
  }
]
