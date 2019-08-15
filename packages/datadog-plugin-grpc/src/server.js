'use strict'

const Tags = require('../../../ext/tags')
const TEXT_MAP = require('../../../ext/formats').TEXT_MAP
const kinds = require('./kinds')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

function handleError (span, err) {
  span.setTag('error', err)
}

function createWrapHandler (grpc, tracer, config, handler) {
  const filter = getFilter(config, 'metadata')

  return function wrapHandler (func) {
    return function funcWithTrace (call, callback) {
      const metadata = call.metadata
      const request = call.request
      const type = this.type
      const isStream = type !== 'unary'
      const scope = tracer.scope()
      const childOf = tracer.extract(TEXT_MAP, metadata.getMap())
      const span = tracer.startSpan('grpc.request', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: 'server',
          'resource.name': handler,
          'service.name': config.service || `${tracer._service}`,
          'component': 'grpc'
        }
      })

      addMethodTags(span, handler, kinds[type])

      if (request && metadata) {
        addMetadataTags(span, metadata, filter, 'request')
      }

      scope.bind(call)

      // Finish the span if the call was cancelled.
      call.on('cancelled', () => {
        span.setTag('grpc.status.code', grpc.status.CANCELLED)
        span.finish()
      })

      if (isStream) {
        wrapStream(span, call)
      } else {
        arguments[1] = wrapCallback(span, callback, filter, grpc, childOf)
      }

      return scope.bind(func, span).apply(this, arguments)
    }
  }
}

function createWrapRegister (tracer, config, grpc) {
  config = config.server || config

  return function wrapRegister (register) {
    return function registerWithTrace (name, handler, serialize, deserialize, type) {
      arguments[1] = createWrapHandler(grpc, tracer, config, name)(handler)

      return register.apply(this, arguments)
    }
  }
}

function wrapStream (span, call) {
  call.on('error', err => {
    span.setTag('grpc.status.code', err.code)

    handleError(span, err)

    span.finish()
  })

  // Finish the span of the response only if it was successful.
  // Otherwise it'll be finished in the `error` listener.
  call.on('finish', () => {
    span.setTag('grpc.status.code', call.status.code)

    if (call.status.code === 0) {
      span.finish()
    }
  })
}

function wrapCallback (span, callback, filter, grpc, childOf) {
  const scope = span.tracer().scope()

  return function (err, value, trailer, flags) {
    if (err) {
      if (err.code) {
        span.setTag('grpc.status.code', err.code)
      }

      handleError(span, err)
    } else {
      span.setTag('grpc.status.code', grpc.status.OK)
    }

    if (trailer && filter) {
      addMetadataTags(span, trailer, filter, 'response')
    }

    span.finish()

    if (callback) {
      scope.bind(callback, childOf).apply(this, arguments)
    }
  }
}

module.exports = [
  {
    name: 'grpc',
    versions: ['>=1.13'],
    patch (grpc, tracer, config) {
      if (config.server === false) return

      grpc.Server._datadog = { grpc }
    },
    unpatch (grpc) {
      delete grpc.Server._datadog
    }
  },
  {
    name: 'grpc',
    versions: ['>=1.13'],
    file: 'src/server.js',
    patch (server, tracer, config) {
      if (config.server === false) return

      const grpc = server.Server._datadog.grpc

      this.wrap(server.Server.prototype, 'register', createWrapRegister(tracer, config, grpc))
    },
    unpatch (server) {
      this.unwrap(server.Server.prototype, 'register')
    }
  }
]
