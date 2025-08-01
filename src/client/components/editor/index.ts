import './components/Button'
import './components/Heightmap'
import './components/LoadMap'
import './components/NationModal'
import './components/NationsPanel'
import './components/NewMap'
import './components/Overlay'
import './components/SaveMap'
import './components/SectionHeader'
import './components/TerrainPanel'
import './components/Toolbar'
import './components/Toolkit'

import { calculatePanTransform, calculateZoomTransform, initializeMap, paintAtPosition } from './engine/actions'
import { customElement, query } from 'lit/decorators.js'
import { DEBUG_RENDER_MODE } from './engine/debug'
import { defaultTerrainThresholds, BrushCursor, getEngineBrushValues } from './types'
import { editorContext, editorStore, type EditorStore, type EditorStoreKey } from './context'
import { EditorEngine } from './engine'
import { extractTerrainColorsFromTheme } from './engine/theme'
import { html, nothing } from 'lit'
import { PastelTheme } from './../../../core/configuration/PastelTheme'
import { PastelThemeDark } from './../../../core/configuration/PastelThemeDark'
import { provide } from '@lit/context'
import { TailwindElement } from './components/TailwindElement'
import { UserSettings } from '../../../core/game/UserSettings'

import type { EditorTool, BrushType } from './types'
import type { HeightmapToolbarElement } from './components/Heightmap'
import type { LoadMapModalElement } from './components/LoadMap'
import type { MapEditorState, EditorTransform, Nation } from './types'
import type { NationModal } from './components/NationModal'
import type { NationsPanel } from './components/NationsPanel'
import type { NewMapModalElement } from './components/NewMap'
import type { SaveMapModalElement } from './components/SaveMap'
import type { TerrainPanel } from './components/TerrainPanel'
import type { Theme } from './../../../core/configuration/Config'
import { canvasToMapCoordinates } from './engine/coordinates'

@customElement('map-editor')
export class MapEditor extends TailwindElement {
  @provide({ context: editorContext }) context: EditorStore = editorStore
  
  @query('canvas') canvas!: HTMLCanvasElement
  @query('new-map-modal') newMapModal!: NewMapModalElement
  @query('load-map-modal') loadMapModal!: LoadMapModalElement
  @query('save-map-modal') saveMapModal!: SaveMapModalElement
  @query('nation-modal') nationModal!: NationModal
  @query('heightmap-toolbar') heightmapToolbar!: HeightmapToolbarElement
  @query('terrain-panel') terrainPanel!: TerrainPanel
  @query('nations-panel') nationsPanel!: NationsPanel

  protected renderLoop: number | null = null
  protected resizeObserver: ResizeObserver | null = null
  protected resizeTimeout: ReturnType<typeof setTimeout> | null = null
  protected userSettings = new UserSettings()
  protected props: Array<EditorStoreKey> = ['isDarkMode', 'currentTool', 'brushSize', 'currentBrush', 'isOpen']
  public renderer: typeof EditorEngine.prototype.renderer | null =
    null as unknown as typeof EditorEngine.prototype.renderer

  render() {
    if (!this.context.isOpen.value) return nothing
    return html`
      <div class="fixed top-0 left-0 w-screen h-screen z-[9999] bg-editor-background text-editor-text flex items-stretch justify-stretch">
        <div class="flex flex-col h-screen w-screen bg-editor-background text-editor-text overflow-hidden flex-1">
          <map-editor-toolbar></map-editor-toolbar>
            <div class="flex-1 relative h-full overflow-hidden">
              <div class="flex flex-row h-full relative overflow-hidden">
                <canvas class="flex-grow w-full h-full cursor-crosshair"></canvas>
                <canvas-overlay 
                  .mapState=${this.context.mapState.value}
                  .transform=${this.context.transform.value}
                  .renderer=${this.renderer ? 'EditorEngine' : 'None'}
                  .hoverCoords=${this.context.hoverCoords.value}
                  .hoverTerrainInfo=${this.context.hoverTerrainInfo.value}
                  .heightmapImage=${this.currentHeightmapImage}
                ></canvas-overlay>
              </div>
              <div class="absolute top-0 left-0 h-full p-4 pointer-events-none flex items-start">
                <terrain-panel class="pointer-events-auto"></terrain-panel>
              </div>
              <div class="absolute top-0 right-0 h-full p-4 pointer-events-none flex flex-row items-start">
                <canvas-overlay
                  .mapState=${this.context.mapState.value}
                  .transform=${this.context.transform.value}
                  .hoverCoords=${this.context.hoverCoords.value}
                  .hoverTerrainInfo=${this.context.hoverTerrainInfo.value}
                  .dataSourceInfo=${this.dataSourceInfo}
                  .heightmapImage=${this.currentHeightmapImage}
                ></canvas-overlay>
                <nations-panel class="pointer-events-auto"></nations-panel>
              </div>
            </div>
          <heightmap-toolbar></heightmap-toolbar>
        </div>
      </div>
      <new-map-modal name="NewMap"></new-map-modal>
      <load-map-modal name="LoadMap"></load-map-modal>
      <save-map-modal name="SaveMap"></save-map-modal>
      <nation-modal name="Nation"></nation-modal>
    `
  }

  constructor() {
    super()
    this.context.isDarkMode.value = this.userSettings.darkMode()
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.context.editor.value = this
    this.context.isDarkMode.value = document.documentElement.classList.contains('dark')
    this.context.terrainThresholds.value = defaultTerrainThresholds
    this.context.transform.value = { zoom: 1, panX: 0, panY: 0 }
    this.context.mapState.value = initializeMap()
    this.addEventListener('error', this.handleComponentError)
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.engine?.dispose()
    this.removeEventListener('error', this.handleComponentError)
  }

  async updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties)

    if (changedProperties.has('isOpen') && this.context.isOpen.value) {
      this.requestUpdate()
      await this.updateComplete
      await this.initializeEngine()
      this.setupCanvasEventListeners()
      this.setupMouseLeaveHandler()
      this.togglePanel('Terrain')
      this.togglePanel('Nations')
      this.togglePanel('Heightmap')
      this.updateTheme()
      this.setupResizeObserver()
    }

    if (this.props.includes('isDarkMode')) {
      this.setAttribute('theme', this.context.isDarkMode.value ? 'dark' : 'light')
      this.updateTheme()
    }

    if (this.props.includes('currentTool') || this.props.includes('brushSize')) this.updateCursor()
    if (this.props.includes('currentBrush')) this.context.currentTool.value = 'paint'
  }

  private async initializeEngine(): Promise<void> {
    if (!this.canvas) return

    const terrainColors = extractTerrainColorsFromTheme(this.theme)
    const options = { preserveDrawingBuffer: true, terrainColors }
    this.context.engine.value = new EditorEngine(this.canvas, options)
    await this.context.engine.value.initialize()
    this.renderer = this.context.engine.value.renderer

    if (this.context.mapState.value.gameMap) {
      await this.updateTerrainData()
    }
    this.startRenderLoop()
    this.resizeCanvas()
    this.centerAndFit()
  }

  private startRenderLoop(): void {
    this.renderLoop = requestAnimationFrame(this.__render)
  }

  get theme(): Theme {
    return this.context.isDarkMode.value ? new PastelThemeDark() : new PastelTheme()
  }

  get currentHeightmapImage(): HTMLImageElement | null {
    return this.engine?.heightmapImage || null
  }

  set currentHeightmapImage(image: HTMLImageElement | null) {
    if (!this.engine) throw new Error('Renderer is not initialized')

    if (image === null) this.engine?.clearHeightmapImage()
    else
      this.engine
        .loadHeightmapImage(image, this.context.heightmapMaxSize.value)
        .then(() => this.requestUpdate())
        .catch((error) => {
          console.error('Failed to load heightmap image:', error)
          this.setError('Failed to load heightmap image')
        })
  }

  get dataSourceInfo() {
    return (
      this.engine?.dataSourceInfo || {
        hasBaseMap: false,
        hasHeightmapImage: false,
        hasHeightmapTexture: false,
        sourceType: 'none'
      }
    )
  }

  private __render = () => {
    if (this.engine) this.engine.render(this.context.mapState.value)
    this.renderLoop = requestAnimationFrame(this.__render)
  }

  public resizeCanvas(): void {
    if (!this.canvas || !this.engine) return

    const container = this.canvas.parentElement
    if (!container) return

    const containerRect = container.getBoundingClientRect()
    const pixelRatio = window.devicePixelRatio || 1
    this.canvas.width = containerRect.width * pixelRatio
    this.canvas.height = containerRect.height * pixelRatio
    this.engine.resize()
  }

  public centerAndFit(): void {
    if (!this.engine || !this.canvas) return

    const mapDimensions = this.engine.chunkManager.mapDimensions

    if (mapDimensions.width === 0 || mapDimensions.height === 0) {
      return
    }

    const canvasRect = this.canvas.getBoundingClientRect()
    const canvasWidth = canvasRect.width
    const canvasHeight = canvasRect.height

    const scaleX = canvasWidth / mapDimensions.width
    const scaleY = canvasHeight / mapDimensions.height
    const zoom = Math.min(scaleX, scaleY) * 0.9

    const transform = {
      zoom,
      panX: 0,
      panY: 0
    }

    this.context.transform.value = transform
    this.engine.setTransform(transform)
  }

  public async updateTerrainData(): Promise<void> {
    if (!this.engine || !this.context.mapState.value.gameMap) return

    const gameMap = this.context.mapState.value.gameMap
    const width = gameMap.width()
    const height = gameMap.height()
    const gameMapWithTerrain = gameMap as any
    const terrainData = gameMapWithTerrain.terrain as Uint8Array

    await this.engine.loadServerMap(terrainData, width, height)

    if (DEBUG_RENDER_MODE) setInterval(() => this.engine?.debugRenderSample(), 2000)
  }

  private updateCursor(): void {
    const canvas = this.canvas
    if (canvas) canvas.style.cursor = BrushCursor[this.context.currentTool.value as EditorTool]
  }

  private updateTheme(): void {
    const theme = this.theme
    for (const [key, color] of Object.entries(theme.editor)) {
      const cssVarName = `--editor-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`
      this.style.setProperty(cssVarName, color.toRgbString())
    }
  }

  private setupCanvasEventListeners(): void {
    if (!this.canvas) return

    this.removeCanvasEventListeners()
    this.canvas.addEventListener('mousedown', this.onMouseDown)
    this.canvas.addEventListener('mousemove', this.onMouseMove)
    this.canvas.addEventListener('mouseup', this.onMouseUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('dblclick', this.onDoubleClick)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
  }
  
  private removeCanvasEventListeners(): void {
    if (!this.canvas) return
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('mousemove', this.onMouseMove)
    this.canvas.removeEventListener('mouseup', this.onMouseUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
  }

  private setupMouseLeaveHandler(): void {
    if (!this.canvas) return
    this.canvas.addEventListener('mouseleave', this.onMouseLeave)
  }

  private onMouseLeave = (): void => {
    this.setBrushCenter(-1000, -1000)
    this.context.hoverCoords.value = null
    this.context.hoverTerrainInfo.value = null
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.canvas) return
    const rect = this.canvas.getBoundingClientRect()
    const canvasX = e.clientX - rect.left
    const canvasY = e.clientY - rect.top
  
    if (e.button === 2) this.onRightDrag(canvasX, canvasY)
    else if (e.button === 0) this.onLeftClick(canvasX, canvasY)
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.canvas) return

    const rect = this.canvas.getBoundingClientRect()
    const canvasX = e.clientX - rect.left
    const canvasY = e.clientY - rect.top

    if (!this.renderer) return
    const coords = this.renderer.canvasToMapCoordinates(canvasX, canvasY)
    if (!coords) return
    const isInBounds = coords.x >= 0 && coords.x < this.context.mapState.value.gameMap.width() && coords.y >= 0 && coords.y < this.context.mapState.value.gameMap.height()
    if (!isInBounds) return
    
    if (this.context.mapState.value.gameMap) {
      this.context.hoverCoords.value = {
        x: Math.floor(coords.x),
        y: Math.floor(coords.y)
      }
      this.setBrushCenter(coords.x, coords.y)
      this.setBrushSize(this.context.brushSize.value)
    } else {
      this.context.hoverCoords.value = null
      this.context.hoverTerrainInfo.value = null
      this.setBrushCenter(-1000, -1000)
    }

    if (this.context.isDragging.value) this.onDrag(canvasX, canvasY)
    else if (!this.context.isDrawing.value) return

    if (isInBounds) this.paint(coords.x, coords.y)
  }

  private onMouseUp = (): void => {
    this.context.isDrawing.value = false
    this.context.isDragging.value = false
    if (this.canvas) this.canvas.style.cursor = BrushCursor[this.context.currentTool.value]
  }

  private onDoubleClick = (e: MouseEvent): void => {
    if (!this.renderer) return
    const canvas = this.canvas
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const canvasX = e.clientX - rect.left
    const canvasY = e.clientY - rect.top

    const hitNation = this.engine?.hitTestNation(canvasX, canvasY, this.context.mapState.value.nations)

    if (hitNation) {
      this.context.editingNation.value = hitNation as Nation
      this.context.isEditingNation.value = true
      this.context.pendingNationCoords.value = null
      this.context.isNationVisible.value = true
      e.preventDefault()
    }
  }

  private onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      this.zoom(e)
      e.preventDefault()
    } else if (e.shiftKey) {
      this.adjustBrushSize(e.deltaY > 0 ? -1 : 1)
      e.preventDefault()
    } else {
      this.cycleTool(e.deltaY > 0 ? 1 : -1)
      e.preventDefault()
    }
  }

  public adjustBrushSize(delta: number): void {
    const newSize = Math.max(1, Math.min(50, this.context.brushSize.value + delta))
    this.setBrushSize(newSize)
  }

  public setBrushSize(size: number): void {
    this.context.brushSize.value = size
    this.engine?.setBrushRadius(size)
  }

  public setBrushMagnitude(magnitude: number): void {
    this.context.brushMagnitude.value = magnitude
    this.engine?.setBrushMagnitude(magnitude)
  }

  public setBrushCenter(x: number, y: number): void {
    this.engine?.setBrushCenter(x, y)
  }

  public setHeightmapMaxSize(size: number): void {
    this.context.heightmapMaxSize.value = size
    this.heightmapToolbar?.debouncedUpdateHeightmap?.()
  }

  public setHeightmapClampMin(value: number): void {
    this.context.heightmapClampMin.value = Math.min(value, this.context.heightmapClampMax.value - 0.01)
    this.heightmapToolbar?.debouncedUpdateHeightmap?.()
  }

  public setHeightmapClampMax(value: number): void {
    this.context.heightmapClampMax.value = Math.max(value, this.context.heightmapClampMin.value + 0.01)
    this.heightmapToolbar?.debouncedUpdateHeightmap?.()
  }

  public updateTerrainColors(colors: any): void {
    this.renderer?.updateTerrainColors(colors)
  }

  public setTool(tool: EditorTool): void {
    this.context.currentTool.value = tool
    this.updateEngineFromContext()
  }

  public setBrush(brush: BrushType): void {
    this.context.currentBrush.value = brush
    this.context.currentTool.value = 'paint'
    this.updateEngineFromContext()
  }

  private cycleTool(delta: number): void {
    if (this.context.currentTool.value === 'paint') {
      this.cycleBrush(delta)
    } else {
      const tools = ['paint', 'erase', 'nation']
      const currentIndex = tools.indexOf(this.context.currentTool.value)
      const newIndex = (currentIndex + delta + tools.length) % tools.length
      this.setTool(tools[newIndex] as any)
    }
  }

  private cycleBrush(delta: number): void {
    const brushes = ['ocean', 'plains', 'highland', 'mountain', 'gaussianblur', 'raiseterrain', 'lowerterrain']
    const currentIndex = brushes.indexOf(this.context.currentBrush.value)
    const newIndex = (currentIndex + delta + brushes.length) % brushes.length
    this.setBrush(brushes[newIndex] as any)
  }

  private updateEngineFromContext(): void {
    if (!this.renderer) return
    const [engineBrushType, brushMagnitude] = getEngineBrushValues(this.context)
    this.renderer.setBrushType(engineBrushType)
    this.setBrushMagnitude(brushMagnitude)
  }

  private onContextMenu = (e: MouseEvent): void => {
    const { canvas, renderer, context, engine } = this
    if (!canvas || !renderer || !context || !engine || context.currentTool.value !== 'nation') return
    e.preventDefault()
    
    const rect = canvas.getBoundingClientRect()
    const canvasX = e.clientX - rect.left
    const canvasY = e.clientY - rect.top
    const hitNation = engine?.hitTestNation(canvasX, canvasY, context.mapState.value.nations)

    if (!hitNation) return
    
    this.context.editingNation.value = hitNation as Nation
    this.context.isEditingNation.value = true
    this.context.pendingNationCoords.value = null
    this.context.isNationVisible.value = true
  }

  private onLeftClick = (canvasX: number, canvasY: number): void => {
    const { engine, context } = this
    if (!engine || !context.mapState.value) return
    context.lastMousePos.value = { x: canvasX, y: canvasY }
    const coords = canvasToMapCoordinates(canvasX, canvasY, context.transform.value)
    if (!coords) return
    const isInBounds = coords.x >= 0 && coords.x < context.mapState.value.gameMap.width() && coords.y >= 0 && coords.y < context.mapState.value.gameMap.height()
    if (!isInBounds) return
    if (context.currentTool.value === 'paint' || context.currentTool.value === 'erase') context.isDrawing.value = true
    paintAtPosition(context, coords.x, coords.y)
  }

  private onRightDrag = (canvasX: number, canvasY: number): void => {
    this.context.lastMousePos.value = { x: canvasX, y: canvasY }
    this.context.isDragging.value = true
  }

  private onDrag = (canvasX: number, canvasY: number): void => {
    const deltaX = canvasX - this.context.lastMousePos.value.x
    const deltaY = canvasY - this.context.lastMousePos.value.y
    const newTransform = calculatePanTransform(this.context.transform.value, deltaX, deltaY)
    this.context.transform.value = newTransform
    this.engine?.setTransform(newTransform)
    this.context.mapState.value && this.engine?.render(this.context.mapState.value)
    this.context.lastMousePos.value = { x: canvasX, y: canvasY }
  }

  private paint = (x: number, y: number): void => {
    if (this.context.currentTool.value === 'nation') {
      this.context.pendingNationCoords.value = [x, y]
      this.context.isEditingNation.value = false
      this.context.editingNation.value = null
      this.context.isNationVisible.value = true
      return
    }
    if (!this.renderer) return
    paintAtPosition(this.context, x, y)
  }

  private zoom = (e: WheelEvent): void => {
    const { canvas, engine, context } = this
    if (!canvas) return

    if (!engine || !context.mapState.value) return

    const rect = canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    const mapDims = engine.chunkManager.mapDimensions

    const newTransform = calculateZoomTransform(
      context.transform.value,
      mouseX,
      mouseY,
      e.deltaY,
      mapDims.width,
      mapDims.height,
      canvas.width,
      canvas.height
    )

    context.transform.value = newTransform
    engine.setTransform(newTransform)
    context.mapState.value && engine.render(context.mapState.value)
  }

  private setupResizeObserver(): void {
    if (!this.canvas) throw new Error('Canvas not found')
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimeout) clearTimeout(this.resizeTimeout)
      this.resizeTimeout = setTimeout(() => {
        this.resizeCanvas()
        this.engine?.renderer.forceRerender()
      }, 16)
    })
    this.resizeObserver?.observe(this.canvas)
  }

  updateMapState(newState: MapEditorState): void {
    this.context.mapState.value = newState
    this.updateTerrainData()
    this.centerAndFit()
    this.updateComplete.then(() => this.engine?.render(this.context.mapState.value))
  }

  switchMode(newRenderMode: number): void {
    this.context.renderMode.value = newRenderMode
    this.engine?.setRenderMode(newRenderMode)
  }

  updateTransform(transform: EditorTransform): void {
    this.context.transform.value = transform
    if (!this.engine) return
    this.engine.setTransform(transform)
    this.engine.renderer.forceRerender()
  }

  public async open(): Promise<void> {
    this.context.isOpen.value = true
    await this.updateComplete
    this.setupCanvasEventListeners()
  }

  public close(): void {
    this.context.isOpen.value = false
  }

  public setError(message: string): void {
    this.context.errorMessage.value = message
  }

  public clearError(): void {
    this.context.errorMessage.value = ''
  }

  public toggleTheme(): void {
    this.userSettings.toggleDarkMode()
    this.context.isDarkMode.value = this.userSettings.darkMode()
  }

  public togglePanel(name: string): void {
    this.context[`is${name}Visible`].value = !this.context[`is${name}Visible`].value
  }

  private handleComponentError = (event: CustomEvent) => {
    const { message } = event.detail
    this.setError(message)
  }
}
