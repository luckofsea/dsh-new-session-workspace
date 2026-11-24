/* dsh-new-session-workspace — browser half.
 *
 * Intercepts an unscoped `uiWorkspace.startSession()` (Ctrl+N, the sidebar
 * New Session row, the expanded brand, and third-party "+" buttons all call it
 * with no workspace id) and asks which workspace the new conversation should
 * use. The dialog offers every existing workspace plus a "create a new
 * workspace" mode whose name defaults to today's date and whose folder is
 * created through the Host directory service.
 *
 * The dialog registers in the frame-wide `shell.overlay` list, so it floats
 * above every column without depending on any particular sidebar renderer.
 */
(function () {
  'use strict'

  var PATCH_KEY = Symbol.for('dsh.new-session-workspace.patch')
  var PARENT_STORAGE_KEY = 'dsh.new-session-workspace.parent'
  var NEW_WORKSPACE = '__new__'
  var PREPARE_ROUTE = '/dsh-new-session-workspace/prepare'
  var HOME_ROUTE = '/dsh-new-session-workspace/home'

  var React = null
  var E = null
  var store = null

  function installPlatform(hostRequire) {
    React = hostRequire('react')
    E = React.createElement
  }

  /* ------------------------------------------------------------- paths */

  function looksWindows(path) {
    return /^[A-Za-z]:/.test(String(path || '')) || String(path || '').indexOf('\\') !== -1
  }

  function trimSeparators(path) {
    return String(path || '').replace(/[\\/]+$/, '')
  }

  function joinPath(parent, name) {
    var base = trimSeparators(parent)
    var leaf = String(name || '').replace(/^[\\/]+/, '')
    if (!base) return leaf
    if (base === '/') return '/' + leaf
    return base + (looksWindows(parent) ? '\\' : '/') + leaf
  }

  function dirnameOf(path) {
    var value = trimSeparators(path)
    if (!value || value === '/') return value
    var index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'))
    if (index <= 0) return value
    var parent = value.slice(0, index)
    if (/^[A-Za-z]:$/.test(parent)) return parent + '/'
    return parent
  }

  function normalizePath(path) {
    var text = String(path || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
    return looksWindows(path) ? text.toLowerCase() : text
  }

  function basenameOf(path) {
    var value = trimSeparators(path)
    var index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'))
    return index >= 0 ? value.slice(index + 1) : value
  }

  function todayName() {
    var now = new Date()
    var month = now.getMonth() + 1
    var day = now.getDate()
    return String(now.getFullYear()) + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day)
  }

  function nameProblem(name) {
    var value = String(name || '').trim()
    if (!value) return '请输入工作区名称'
    if (/[\\/:*?"<>|]/.test(value)) return '名称不能包含 \\ / : * ? " < > |'
    if (value === '.' || value === '..') return '名称不能是 . 或 ..'
    return ''
  }

  function readStoredParent() {
    try {
      var value = window.localStorage.getItem(PARENT_STORAGE_KEY)
      return typeof value === 'string' ? value : ''
    } catch (error) {
      return ''
    }
  }

  function rememberParent(parent) {
    try {
      window.localStorage.setItem(PARENT_STORAGE_KEY, parent)
    } catch (error) {
      /* storage may be unavailable; the dialog still works */
    }
  }

  function describeError(error) {
    if (!error) return '操作失败，请重试'
    if (typeof error === 'string') return error.replace(/^Error:\s*/, '')
    if (typeof error.message === 'string' && error.message) return error.message.replace(/^Error:\s*/, '')
    try {
      var json = JSON.stringify(error)
      if (json && json !== '{}') return json
    } catch (inner) {
      /* a circular payload still has to read as a failure */
    }
    if (error.code != null) return String(error.code)
    if (error.name != null && error.name !== 'Error') return String(error.name)
    return '操作失败，请重试'
  }

  /* ----------------------------------------------------------- services */

  function createServices(ctx, original) {
    var workspaceApi = ctx.get('workspaces')
    var service = ctx.get('uiWorkspace')
    var sessions = ctx.get('sessions')

    function listItems() {
      try {
        var snapshot = workspaceApi.list.getSnapshot()
        return snapshot && Array.isArray(snapshot.items) ? snapshot.items.slice() : []
      } catch (error) {
        return []
      }
    }

    // The session store keeps one row per open Session with a `retainedBy`
    // census; the row claimed by the main view is the conversation on screen.
    function currentSessionId() {
      try {
        var snapshot = sessions.list.getSnapshot()
        var byId = snapshot && snapshot.byId
        if (!byId) return null
        var ids = Object.keys(byId)
        for (var index = 0; index < ids.length; index += 1) {
          var row = byId[ids[index]]
          if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) {
            return String(row.sessionId || ids[index])
          }
        }
      } catch (error) {
        /* the session store may not be ready yet */
      }
      return null
    }

    function currentWorkspace() {
      var sessionId = currentSessionId()
      if (!sessionId) return null
      var items = listItems()
      for (var index = 0; index < items.length; index += 1) {
        var ids = items[index] && items[index].sessionIds
        if (!Array.isArray(ids)) continue
        for (var scan = 0; scan < ids.length; scan += 1) {
          if (String(ids[scan]) === sessionId) return items[index]
        }
      }
      return null
    }

    function currentWorkspaceId() {
      var view = currentWorkspace()
      return view ? String(view.workspaceId) : null
    }

    function currentWorkspacePath() {
      var view = currentWorkspace()
      return view ? String(view.path || '') : ''
    }

    function mostRecentWorkspacePath() {
      var items = listItems()
      return items.length ? String(items[0].path || '') : ''
    }

    function startSession(workspaceId, options) {
      original.call(service, workspaceId, options)
    }

    function startInWorkspace(workspaceId, options) {
      startSession(workspaceId, options)
    }

    // The Host folder routes are same-origin JSON endpoints. The native
    // directory picker has no `createDirectory`, so the dialog creates the
    // folder through this package's own Host half instead.
    function postJson(route, payload) {
      if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
        return Promise.reject(new Error('当前页面无法访问宿主机服务'))
      }
      return window.fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {})
      }).then(function (response) {
        var status = response.status
        return response.text().then(function (text) {
          var data = null
          try {
            data = text ? JSON.parse(text) : null
          } catch (error) {
            data = null
          }
          if (!data) {
            throw new Error('宿主机路由 ' + route + ' 返回了无法解析的响应（HTTP ' + status + '）')
          }
          if (data.ok !== true) {
            var detail = data.detail || data.error
            throw new Error(detail ? String(detail) : '宿主机拒绝了请求（HTTP ' + status + '）')
          }
          return data
        })
      })
    }

    function prepareWorkspace(parent, name) {
      return postJson(PREPARE_ROUTE, { parent: parent, name: name }).then(function (data) {
        return typeof data.path === 'string' && data.path ? data.path : joinPath(parent, name)
      })
    }

    function homeDirectory() {
      return postJson(HOME_ROUTE, {}).then(function (data) {
        return typeof data.home === 'string' ? data.home : ''
      }, function () {
        return ''
      })
    }

    function registerWorkspace(path) {
      return workspaceApi.create({ path: path }).then(function (view) {
        return String(view.workspaceId)
      }, function (error) {
        var existing = findByPath(path)
        if (existing) return String(existing.workspaceId)
        throw error
      })
    }

    function findByPath(path) {
      var want = normalizePath(path)
      var items = listItems()
      for (var index = 0; index < items.length; index += 1) {
        if (normalizePath(items[index].path) === want) return items[index]
      }
      return null
    }

    function createWorkspace(parent, name) {
      return prepareWorkspace(parent, name).then(function (target) {
        return registerWorkspace(target)
      })
    }

    function pickDirectory() {
      if (typeof service.pickDirectory !== 'function') {
        return Promise.reject(new Error('当前宿主版本不支持浏览文件夹'))
      }
      return service.pickDirectory()
    }

    return {
      listItems: listItems,
      currentWorkspaceId: currentWorkspaceId,
      currentWorkspacePath: currentWorkspacePath,
      mostRecentWorkspacePath: mostRecentWorkspacePath,
      startInWorkspace: startInWorkspace,
      createWorkspace: createWorkspace,
      pickDirectory: pickDirectory,
      homeDirectory: homeDirectory
    }
  }

  /* -------------------------------------------------------------- store */

  function createStore(services) {
    var state = {
      open: false,
      mode: 'existing',
      items: [],
      selectedId: null,
      name: '',
      parent: '',
      busy: false,
      error: ''
    }
    var pending = null
    var listeners = []

    function patch(next) {
      var updated = {}
      for (var key in state) {
        if (Object.prototype.hasOwnProperty.call(state, key)) updated[key] = state[key]
      }
      for (var field in next) {
        if (Object.prototype.hasOwnProperty.call(next, field)) updated[field] = next[field]
      }
      state = updated
      for (var index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index](state)
        } catch (error) {
          /* one broken consumer must not break the dialog */
        }
      }
    }

    function close() {
      pending = null
      patch({ open: false, mode: 'existing', busy: false, items: [], error: '' })
    }

    function open(options) {
      if (state.open) return
      pending = options || null
      var items = services.listItems()
      var selected = services.currentWorkspaceId() || (items.length ? String(items[0].workspaceId) : null)
      var parent = readStoredParent() || dirnameOf(services.currentWorkspacePath() || services.mostRecentWorkspacePath())
      patch({
        open: true,
        mode: items.length ? 'existing' : 'new',
        items: items,
        selectedId: selected,
        name: todayName(),
        parent: parent,
        busy: false,
        error: ''
      })
      if (!parent) {
        services.homeDirectory().then(function (home) {
          if (state.open && !state.parent && home) patch({ parent: home })
        }, function () {})
      }
    }

    function selectExisting(workspaceId) {
      patch({ mode: 'existing', selectedId: String(workspaceId), error: '' })
    }

    function selectNew() {
      patch({ mode: 'new', error: '' })
    }

    function setName(value) {
      patch({ name: value, error: '' })
    }

    function setParent(value) {
      patch({ parent: value, error: '' })
    }

    function browse() {
      services.pickDirectory().then(function (picked) {
        if (picked) patch({ parent: picked, error: '' })
      }, function (error) {
        patch({ error: describeError(error) })
      })
    }

    function move(step) {
      if (!state.items.length) return
      var order = []
      var index = 0
      for (index = 0; index < state.items.length; index += 1) order.push(String(state.items[index].workspaceId))
      order.push(NEW_WORKSPACE)
      var current = state.mode === 'new' ? NEW_WORKSPACE : (state.selectedId || order[0])
      var at = order.indexOf(current)
      if (at < 0) at = 0
      var next = order[(at + step + order.length) % order.length]
      if (next === NEW_WORKSPACE) selectNew()
      else selectExisting(next)
    }

    function commit() {
      if (state.busy) return
      if (state.mode === 'existing') {
        if (!state.selectedId) return
        var existing = pending
        close()
        services.startInWorkspace(state.selectedId, existing)
        return
      }
      var problem = nameProblem(state.name)
      if (problem) {
        patch({ error: problem })
        return
      }
      var parent = String(state.parent || '').trim()
      if (!parent) {
        patch({ error: '请选择存放位置' })
        return
      }
      var captured = pending
      patch({ busy: true, error: '' })
      services.createWorkspace(parent, String(state.name).trim()).then(function (workspaceId) {
        pending = null
        rememberParent(trimSeparators(parent))
        close()
        services.startInWorkspace(workspaceId, captured)
      }, function (error) {
        if (window.console && typeof window.console.error === 'function') {
          window.console.error('[dsh-new-session-workspace] create failed:', error)
        }
        patch({ busy: false, error: describeError(error) })
      })
    }

    return {
      getState: function () {
        return state
      },
      subscribe: function (listener) {
        listeners.push(listener)
        return function () {
          var at = listeners.indexOf(listener)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
      open: open,
      cancel: close,
      selectExisting: selectExisting,
      selectNew: selectNew,
      setName: setName,
      setParent: setParent,
      browse: browse,
      move: move,
      commit: commit
    }
  }

  /* ------------------------------------------------------------ overlay */

  function canCommit(state) {
    if (state.busy) return false
    if (state.mode === 'new') return Boolean(String(state.parent || '').trim()) && !nameProblem(state.name)
    return Boolean(state.selectedId)
  }

  function Overlay() {
    var pair = React.useState(store.getState())
    var state = pair[0]
    var setState = pair[1]
    var panelRef = React.useRef(null)
    var nameRef = React.useRef(null)

    React.useEffect(function () {
      return store.subscribe(function (next) {
        setState(next)
      })
    }, [])

    React.useEffect(function () {
      if (!state.open) return undefined
      var timer = setTimeout(function () {
        if (state.mode === 'new' && nameRef.current) {
          nameRef.current.focus()
          nameRef.current.select()
        } else if (panelRef.current) {
          panelRef.current.focus()
        }
      }, 30)
      return function () {
        clearTimeout(timer)
      }
    }, [state.open, state.mode])

    React.useEffect(function () {
      if (!state.open) return undefined
      function onKeyDown(event) {
        if (event.isComposing || event.keyCode === 229) return
        var target = event.target
        var tag = (target && target.tagName) || ''
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          store.cancel()
          return
        }
        if (event.key === 'Enter' && tag !== 'BUTTON' && tag !== 'TEXTAREA') {
          event.preventDefault()
          event.stopPropagation()
          store.commit()
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (tag === 'INPUT' || tag === 'TEXTAREA') return
          event.preventDefault()
          event.stopPropagation()
          store.move(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (event.key === 'Tab' && panelRef.current) {
          var focusables = panelRef.current.querySelectorAll('button:not([disabled]), input:not([disabled])')
          if (!focusables.length) return
          var first = focusables[0]
          var last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
      }
      document.addEventListener('keydown', onKeyDown, true)
      return function () {
        document.removeEventListener('keydown', onKeyDown, true)
      }
    }, [state.open])

    if (!state.open) return null

    var creating = state.mode === 'new'
    var commitLabel = state.busy ? '正在创建…' : (creating ? '创建并开始' : '开始对话')

    function renderItem(item) {
      var id = String(item.workspaceId)
      var active = !creating && state.selectedId === id
      var title = String(item.title || '') || basenameOf(item.path) || id
      return E('button', {
        key: id,
        type: 'button',
        role: 'option',
        'aria-selected': active,
        className: 'dsh-nsw-row' + (active ? ' is-active' : ''),
        onClick: function () {
          store.selectExisting(id)
        },
        onDoubleClick: function () {
          store.commit()
        }
      },
        E('span', { className: 'dsh-nsw-radio', 'aria-hidden': 'true' }),
        E('span', { className: 'dsh-nsw-rowtext' },
          E('span', { className: 'dsh-nsw-rowtitle' }, title),
          E('span', { className: 'dsh-nsw-rowpath', title: String(item.path || '') }, String(item.path || ''))
        )
      )
    }

    var form = creating ? E('div', { className: 'dsh-nsw-form' },
      E('div', { className: 'dsh-nsw-field' },
        E('label', { className: 'dsh-nsw-label', htmlFor: 'dsh-nsw-name' }, '工作区名称'),
        E('input', {
          id: 'dsh-nsw-name',
          ref: nameRef,
          className: 'dsh-nsw-input',
          type: 'text',
          value: state.name,
          placeholder: todayName(),
          spellCheck: false,
          autoComplete: 'off',
          disabled: state.busy,
          onChange: function (event) {
            store.setName(event.target.value)
          }
        })
      ),
      E('div', { className: 'dsh-nsw-field' },
        E('label', { className: 'dsh-nsw-label', htmlFor: 'dsh-nsw-parent' }, '存放位置'),
        E('div', { className: 'dsh-nsw-inputrow' },
          E('input', {
            id: 'dsh-nsw-parent',
            className: 'dsh-nsw-input',
            type: 'text',
            value: state.parent,
            spellCheck: false,
            autoComplete: 'off',
            disabled: state.busy,
            onChange: function (event) {
              store.setParent(event.target.value)
            }
          }),
          E('button', {
            type: 'button',
            className: 'dsh-nsw-btn ghost dsh-nsw-browse',
            disabled: state.busy,
            onClick: function () {
              store.browse()
            }
          }, '浏览…')
        )
      ),
      E('div', { className: 'dsh-nsw-preview' },
        E('span', { className: 'dsh-nsw-preview-label' }, '将创建'),
        E('span', { className: 'dsh-nsw-preview-path' },
          state.parent ? joinPath(state.parent, state.name || '…') : '请先选择存放位置')
      )
    ) : null

    return E('div', {
      className: 'dsh-nsw-backdrop',
      onMouseDown: function (event) {
        if (event.target === event.currentTarget) store.cancel()
      }
    },
      E('div', {
        className: 'dsh-nsw-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dsh-nsw-title',
        tabIndex: -1,
        ref: panelRef,
        onMouseDown: function (event) {
          event.stopPropagation()
        }
      },
        E('div', { className: 'dsh-nsw-head' },
          E('div', { className: 'dsh-nsw-title', id: 'dsh-nsw-title' }, '新建对话'),
          E('div', { className: 'dsh-nsw-sub' }, '选择本次对话使用的工作区文件夹'),
          E('button', {
            type: 'button',
            className: 'dsh-nsw-close',
            'aria-label': '关闭',
            title: '关闭（Esc）',
            onClick: function () {
              store.cancel()
            }
          }, '✕')
        ),
        E('div', { className: 'dsh-nsw-body' },
          state.items.length
            ? E('div', { className: 'dsh-nsw-list', role: 'listbox', 'aria-label': '现有工作区' },
              state.items.map(renderItem),
              E('div', { className: 'dsh-nsw-divider', role: 'presentation' })
            )
            : E('div', { className: 'dsh-nsw-empty' }, '还没有工作区，先创建一个吧'),
          E('button', {
            type: 'button',
            role: 'option',
            'aria-selected': creating,
            className: 'dsh-nsw-row dsh-nsw-row-new' + (creating ? ' is-active' : ''),
            onClick: function () {
              store.selectNew()
            }
          },
            E('span', { className: 'dsh-nsw-radio', 'aria-hidden': 'true' }),
            E('span', { className: 'dsh-nsw-rowtext' },
              E('span', { className: 'dsh-nsw-rowtitle' }, '新建工作区'),
              E('span', { className: 'dsh-nsw-rowpath' }, '创建文件夹，并作为本次对话的工作区')
            )
          ),
          form
        ),
        E('div', { className: 'dsh-nsw-foot' },
          state.error ? E('div', { className: 'dsh-nsw-error', role: 'alert' }, state.error) : null,
          E('div', { className: 'dsh-nsw-footrow' },
            E('span', { className: 'dsh-nsw-hint' }, 'Enter 确认 · Esc 取消'),
            E('div', { className: 'dsh-nsw-actions' },
              E('button', {
                type: 'button',
                className: 'dsh-nsw-btn ghost',
                disabled: state.busy,
                onClick: function () {
                  store.cancel()
                }
              }, '取消'),
              E('button', {
                type: 'button',
                className: 'dsh-nsw-btn primary',
                disabled: !canCommit(state),
                onClick: function () {
                  store.commit()
                }
              }, commitLabel)
            )
          )
        )
      )
    )
  }

  /* -------------------------------------------------------------- patch */

  function installPatch(service, original, target) {
    if (service[PATCH_KEY]) return function () {}
    var patched = function (workspaceId, options) {
      if (workspaceId !== undefined && workspaceId !== null) {
        return original.call(this, workspaceId, options)
      }
      target.open(options)
    }
    service.startSession = patched
    service[PATCH_KEY] = { original: original, patched: patched }
    return function () {
      var record = service[PATCH_KEY]
      if (!record || record.patched !== patched) return
      service.startSession = original
      try {
        delete service[PATCH_KEY]
      } catch (error) {
        service[PATCH_KEY] = undefined
      }
      target.cancel()
    }
  }

  /* -------------------------------------------------------------- style */

  var STYLE_TEXT = [
    '.dsh-nsw-backdrop{pointer-events:auto;position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(12,15,20,.44);animation:dsh-nsw-fade .12s ease-out}',
    '.dsh-nsw-panel{width:min(540px,100%);max-height:min(640px,calc(100vh - 48px));display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 24px 64px rgba(0,0,0,.3);outline:none;font:inherit;font-size:14px;animation:dsh-nsw-rise .14s ease-out}',
    '.dsh-nsw-head{position:relative;flex:none;padding:20px 20px 6px}',
    '.dsh-nsw-title{font-size:16px;font-weight:600;line-height:1.4}',
    '.dsh-nsw-sub{margin-top:4px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#6a6f76)}',
    '.dsh-nsw-close{position:absolute;top:14px;right:14px;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6a6f76);font-size:14px;line-height:1;cursor:pointer}',
    '.dsh-nsw-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2328)}',
    '.dsh-nsw-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:6px;padding:6px 16px 10px;overflow-y:auto}',
    '.dsh-nsw-list{display:flex;flex-direction:column;gap:2px;padding:4px 0}',
    '.dsh-nsw-row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
    '.dsh-nsw-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
    '.dsh-nsw-row.is-active{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
    '.dsh-nsw-radio{flex:none;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.28));display:flex;align-items:center;justify-content:center}',
    '.dsh-nsw-row.is-active .dsh-nsw-radio{border-color:var(--dsw-alias-state-business-primary,#3b6ef5)}',
    '.dsh-nsw-row.is-active .dsh-nsw-radio::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3b6ef5)}',
    '.dsh-nsw-rowtext{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.dsh-nsw-rowtitle{font-size:13.5px;font-weight:500;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-nsw-rowpath{font-size:11.5px;line-height:1.35;color:var(--dsw-alias-label-tertiary,#8a9099);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-nsw-divider{height:1px;margin:6px 4px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.07))}',
    '.dsh-nsw-row-new{flex:none;margin:0 0 2px}',
    '.dsh-nsw-empty{flex:none;padding:10px 4px;font-size:13px;color:var(--dsw-alias-label-secondary,#6a6f76)}',
    '.dsh-nsw-form{flex:none;display:flex;flex-direction:column;gap:12px;margin:4px 0 6px;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04)))}',
    '.dsh-nsw-field{display:flex;flex-direction:column;gap:6px}',
    '.dsh-nsw-label{font-size:12px;color:var(--dsw-alias-label-secondary,#6a6f76)}',
    '.dsh-nsw-inputrow{display:flex;gap:8px;align-items:center}',
    '.dsh-nsw-input{flex:1 1 auto;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:13px;outline:none}',
    '.dsh-nsw-input:focus{border-color:var(--dsw-alias-state-business-primary,#3b6ef5);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,rgba(59,110,245,.18))}',
    '.dsh-nsw-input:disabled{opacity:.6}',
    '.dsh-nsw-browse{flex:none}',
    '.dsh-nsw-preview{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9099);word-break:break-all}',
    '.dsh-nsw-preview-label{flex:none;color:var(--dsw-alias-label-secondary,#6a6f76)}',
    '.dsh-nsw-preview-path{font-family:var(--dsh-code-font-family,ui-monospace,Consolas,monospace);font-size:11.5px}',
    '.dsh-nsw-error{flex:none;margin:2px 0;padding:8px 10px;border-radius:8px;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-state-error-primary,#c62f2f);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62f2f) 10%,transparent)}',
    '.dsh-nsw-foot{flex:none;display:flex;flex-direction:column;gap:10px;padding:12px 20px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}',
    '.dsh-nsw-footrow{display:flex;align-items:center;justify-content:space-between;gap:12px}',
    '.dsh-nsw-actions{display:flex;gap:8px}',
    '.dsh-nsw-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9099)}',
    '.dsh-nsw-btn{appearance:none;border:0;border-radius:8px;padding:8px 16px;font:inherit;font-size:13px;line-height:1.2;cursor:pointer}',
    '.dsh-nsw-btn:disabled{cursor:default;opacity:.5}',
    '.dsh-nsw-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b6ef5));color:#fff}',
    '.dsh-nsw-btn.primary:hover:not(:disabled){filter:brightness(1.06)}',
    '.dsh-nsw-btn.ghost{background:transparent;color:var(--dsw-alias-label-secondary,#6a6f76)}',
    '.dsh-nsw-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2328)}',
    '@keyframes dsh-nsw-fade{from{opacity:0}to{opacity:1}}',
    '@keyframes dsh-nsw-rise{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}',
    '@media (prefers-reduced-motion:reduce){.dsh-nsw-backdrop,.dsh-nsw-panel{animation:none}}'
  ].join('\n')

  /* -------------------------------------------------------------- apply */

  function apply(ctx) {
    var slots = ctx.get('slots')
    var service = ctx.get('uiWorkspace')
    var workspaceApi = ctx.get('workspaces')

    // `sessions` only sharpens the default folder hint; the dialog works without it.
    if (!slots || !service || !workspaceApi) {
      console.error('[dsh-new-session-workspace] required client services are unavailable; picker disabled')
      return
    }    if (typeof service.startSession !== 'function') {
      console.error('[dsh-new-session-workspace] uiWorkspace.startSession is unavailable; picker disabled')
      return
    }

    var original = service.startSession
    store = createStore(createServices(ctx, original))

    ctx.effect(function () {
      return installPatch(service, original, store)
    }, 'new-session-workspace: intercept unscoped new sessions')

    ctx.effect(function () {
      return slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'dsh-new-session-workspace.dialog' }, Overlay)
      })
    }, 'new-session-workspace: dialog overlay')

    ctx.effect(function () {
      var style = document.createElement('style')
      style.id = 'dsh-new-session-workspace-style'
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
      return function () {
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }, 'new-session-workspace: styles')

    console.log('[dsh-new-session-workspace] ready')

    try {
      window.__dshNewSessionWorkspace = {
        open: function () {
          store.open({})
        },
        state: function () {
          return store.getState()
        }
      }
    } catch (error) {
      /* a read-only global must never break activation */
    }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-new-session-workspace',
    factory: function (hostRequire) {
      installPlatform(hostRequire)
      return {
        name: 'dsh-new-session-workspace',
        inject: ['slots', 'uiWorkspace', 'workspaces', 'sessions'],
        apply: apply
      }
    }
  })
})()
