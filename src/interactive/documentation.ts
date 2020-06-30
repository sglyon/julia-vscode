import * as path from 'path'
import * as vscode from 'vscode'
import { withLanguageClient } from '../extension'
import { getParamsAtPosition, setContext } from '../utils'

const viewType = 'JuliaDocumentationBrowser'
const panelActiveContextKey = 'juliaDocumentationPaneActive'
let extensionPath: string = undefined
let panel: vscode.WebviewPanel = undefined
let messageSubscription: vscode.Disposable = undefined

const backStack = Array<string>() // also keep current page
let forwardStack = Array<string>()

export function activate(context: vscode.ExtensionContext) {
    // assets path
    extensionPath = context.extensionPath
    context.subscriptions.push(
        vscode.commands.registerCommand('language-julia.show-documentation-pane', showDocumentationPane),
        vscode.commands.registerCommand('language-julia.show-documentation', showDocumentation),
        vscode.commands.registerCommand('language-julia.browse-back-documentation', browseBack),
        vscode.commands.registerCommand('language-julia.browse-forward-documentation', browseForward),
    )
    setPanelContext()
    vscode.window.registerWebviewPanelSerializer(viewType, new DocumentationPaneSerializer())
}

function showDocumentationPane() {
    if (panel === undefined) {
        panel = createDocumentationPanel()
        setPanelSubscription(panel)
    }
    if (panel !== undefined && !panel.visible) {
        panel.reveal()
    }
}

function createDocumentationPanel() {
    return vscode.window.createWebviewPanel(viewType, 'Julia Documentation Pane',
        {
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Beside,
        },
        {
            enableFindWidget: true,
            // retainContextWhenHidden: true, // comment in if loading is slow, while there would be high memory overhead
            enableScripts: true,
        }
    )
}

class DocumentationPaneSerializer implements vscode.WebviewPanelSerializer {
    async deserializeWebviewPanel(deserializedPanel: vscode.WebviewPanel, state: any) {
        panel = deserializedPanel
        setPanelSubscription(panel)
        const { inner } = state
        const html = createWebviewHTML(inner)
        _setHTML(html)
    }
}

function setPanelSubscription(panel: vscode.WebviewPanel) {
    panel.onDidChangeViewState(({ webviewPanel }) => {
        setPanelContext(webviewPanel.active)
    })
    panel.onDidDispose(() => {
        setPanelContext(false)
        if (messageSubscription !== undefined) {
            messageSubscription.dispose()
        }
        panel = null
    })
    setPanelContext(true)
}

function setPanelContext(state: boolean = false) {
    setContext(panelActiveContextKey, state)
}

const LS_ERR_MSG = `
Error: Julia Language server is not running.
Please wait a few seconds and try again once the \`Starting Julia Language Server...\` message in the status bar is gone.
`
async function showDocumentation() {
    // telemetry.traceEvent('command-showdocumentation')
    const inner = await getDocumentation()
    setDocumentation(inner)
}

async function getDocumentation(): Promise<string> {
    const editor = vscode.window.activeTextEditor
    const selection = editor.selection
    const position = new vscode.Position(selection.start.line, selection.start.character)

    return await withLanguageClient(
        async languageClient => {
            const params = getParamsAtPosition(editor, position)
            return languageClient.sendRequest('julia/getDocAt', params)
        },
        err => {
            vscode.window.showErrorMessage(LS_ERR_MSG)
            return ''
        }
    )
}

function setDocumentation(inner: string) {
    if (!inner) { return }
    forwardStack = [] // initialize forward page stack for manual search
    showDocumentationPane()
    const html = createWebviewHTML(inner)
    _setHTML(html)
}

function createWebviewHTML(inner: string) {
    const darkMode: boolean = vscode.workspace.getConfiguration('julia.documentation').darkMode

    const assetsDir = path.join(extensionPath, 'assets')
    const googleFonts = panel.webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, 'google_fonts')))
    const fontawesome = panel.webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, 'fontawesome.min.css')))
    const solid = panel.webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, 'solid.min.css')))
    const brands = panel.webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, 'brands.min.css')))
    const katex = panel.webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, 'katex.min.css')))
    const require = panel.webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, 'require.min.js')))
    const documenterScript = panel.webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, 'documenter.js')))
    const documenterStylesheet = panel.webview.asWebviewUri(vscode.Uri.file(path.join(assetsDir, darkMode ? 'documenter-dark.css' : 'documenter-light.css')))

    return `
<!DOCTYPE html>
<html lang="en" class=${darkMode ? 'theme--documenter-dark' : ''}>

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Julia Documentation Pane</title>
    <link href=${googleFonts} rel="stylesheet" type="text/css" />
    <link href=${fontawesome} rel="stylesheet" type="text/css" />
    <link href=${solid} rel="stylesheet" type="text/css" />
    <link href=${brands} rel="stylesheet" type="text/css" />
    <link href=${katex} rel="stylesheet" type="text/css" />
    <script src=${require} data-main=${documenterScript}></script>
    <link href=${documenterStylesheet} rel="stylesheet" type="text/css">

    <script type="text/javascript">
        const vscode = acquireVsCodeApi()
        window.onload = () => {
            const els = document.getElementsByTagName('a')
            for (const el of els) {
                const href = el.getAttribute('href')
                if (href.includes('julia-vscode/')) {
                    const mod = href.split('/').pop()
                    el.onclick = () => {
                        vscode.postMessage({
                            method: 'search',
                            params: {
                                word: el.text,
                                mod
                            }
                        })
                    }
                }
            }
        }
        vscode.setState({ inner: \`${inner}\` })
    </script>

</head>

<body>
    <div class="docs-main" style="padding: 1em">
        <article class="content">
            ${inner}
        </article>
    </div>
</body>

</html>
`
}

function _setHTML(html: string) {
    // set current stack
    backStack.push(html)

    // TODO: link handling for documentations retrieved from LS
    if (messageSubscription !== undefined) {
        messageSubscription.dispose() // dispose previouse
    }
    messageSubscription = panel.webview.onDidReceiveMessage(
        message => {
            if (message.method === 'search') {
                // withREPL(
                //     async connection => {
                //         const { word, mod } = message.params
                //         const inner = await connection.sendRequest(requestTypeGetDoc, { word, mod, })
                //         setDocumentation(inner)
                //     },
                //     err => { return '' }
                // )
            }
        }
    )

    panel.webview.html = html
}

function isBrowseBackAvailable() {
    return backStack.length > 1
}

function isBrowseForwardAvailable() {
    return forwardStack.length > 0
}

function browseBack() {
    if (!isBrowseBackAvailable()) { return }

    const current = backStack.pop()
    forwardStack.push(current)

    _setHTML(backStack.pop())
}

function browseForward() {
    if (!isBrowseForwardAvailable()) { return }

    _setHTML(forwardStack.pop())
}
