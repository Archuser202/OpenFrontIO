import { Modal } from './Modal'
import { customElement, property, state } from 'lit/decorators.js'
import {
  getAllLocalMapNames,
  deleteLocalMap,
  loadMap,
  getServerMapMetadata,
  getServerMapImage,
  loadMapFromLocalStorage
} from '../engine/io'
import { html, nothing, type PropertyValues } from 'lit'
import { TailwindElement } from './TailwindElement'
import { MAP_NAME_MAPPING } from '../engine/constants'
import type { MapManifest } from '../../../../core/game/TerrainMapLoader'
import type { EditorStoreKey } from '../context'

@customElement('load-map-modal')
export class LoadMapModalElement extends Modal {
  protected props: Array<EditorStoreKey> = ['isLoadMapVisible']
  @state() private selectedMap: string | null = null
  @state() private serverMaps = Object.keys(MAP_NAME_MAPPING) as unknown as (keyof typeof MAP_NAME_MAPPING)[]
  @state() private localMaps: string[] = []
  @state() private isLoadingLocalMaps = false
  @state() private deletingMapId: string | null = null

  connectedCallback(): void {
    super.connectedCallback()
    this.loadLocalMaps()
    this.addEventListener('select', this.handleMapSelect)
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.removeEventListener('select', this.handleMapSelect)
  }

  private handleMapSelect = (event: CustomEvent) => {
    this.selectedMap = event.detail.mapName
    this.requestUpdate()
  }

  private async loadLocalMaps(): Promise<void> {
    this.isLoadingLocalMaps = true
    this.localMaps = await getAllLocalMapNames()
    this.isLoadingLocalMaps = false
  }

  private async handleDeleteMap(mapId: string, event: Event): Promise<void> {
    event.stopPropagation()

    if (!confirm(`Are you sure you want to delete "${mapId}"? This action cannot be undone.`)) return

    this.deletingMapId = mapId
    await deleteLocalMap(mapId)
    await this.loadLocalMaps()

    if (this.selectedMap === `local:${mapId}`) this.selectedMap = null
  }

  private async handleLoad(): Promise<void> {
    if (!this.selectedMap) return

    const loadData = { mapName: this.selectedMap }
    this.loadMap(new CustomEvent('submit', { detail: loadData }))
    this.hide()
  }

  private async loadMap(event: CustomEvent): Promise<void> {
    const loaded = await loadMap(event.detail.mapName)
    if (!loaded) return this.editor.setError('Failed to load map.')
    this.editor.updateMapState(loaded)
  }

  render = () => {
    if (this.name ? !this.context[`is${this.name}Visible`].value : !this.open) return nothing
    return html`
      <modal-base
        .name=${this.name}
        .open=${this.open}
        .errorMessage=${this.errorMessage}
        .closeHandler=${this.hide}
        .styles=${this.styles}
      >
      <span slot="title">📂 Load Map</span>
      <div slot="actions" class="flex gap-3 justify-end">
        <e-button variant="secondary" .icon=${'❌'} @click=${this.hide} />
        <e-button variant="primary" .icon=${'📂'} ?disabled=${!this.selectedMap} @click=${this.handleLoad} />
      </div>
      <div class="mb-6">
        <div class="text-lg font-semibold text-editor-text mb-3">🌍 Server Maps</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          ${this.serverMaps.map(
            (map) => html`
            <load-map-item 
              .mapName=${map}
              .isLocal=${false}
              .isSelected=${this.selectedMap === map}
              .handleDeleteMap=${() => {}}
            ></load-map-item>
          `
          )}
        </div>
      </div>
      <div class="mb-6">
        <div class="text-lg font-semibold text-editor-text mb-3 flex items-center justify-between">
          💾 Local Maps
          <only-show .if=${!this.isLoadingLocalMaps}>
            <load-map-refresh-button .handleRefresh=${this.loadLocalMaps}></load-map-refresh-button>
          </only>
          <only-show .if=${this.isLoadingLocalMaps}>
            <load-map-loading-indicator></load-map-loading-indicator>
          </only>
        </div>
        <only-show .if=${this.localMaps.length > 0}>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${this.localMaps.map(
              (key) => html`
              <load-map-item 
                .mapName=${key.replace(/^mapeditor_/, '')}
                .isLocal=${true}
                .isSelected=${this.selectedMap === `local:${key}`}
                .isDeleting=${this.deletingMapId === key}
                .handleDeleteMap=${(e: Event) => this.handleDeleteMap(key, e)}
              ></load-map-item>
            `
            )}
          </div>
        </only>
        <only-show .if=${this.localMaps.length === 0}>
          <div class="text-center py-8 text-editor-secondary">
            <only-show .if=${this.isLoadingLocalMaps}>
              Loading local maps...
            </only>
            <only-show .if=${!this.isLoadingLocalMaps}>
              <div>No local maps found.</div>
              <div>Create and save a map to see it here.</div>
            </only>
          </div>
        </only>
      </div>
    `
  }
}

@customElement('load-map-item')
export class LoadMapItem extends TailwindElement {
  @property({ type: String }) mapName: string
  @property({ type: Boolean }) isLocal: boolean
  @property({ type: Boolean }) isSelected: boolean
  @property({ type: Boolean }) isDeleting: boolean
  @property({ type: Function }) handleDeleteMap: (mapName: string, event: Event) => void
  @state() private manifest: MapManifest = null as unknown as MapManifest
  @state() private image = ''

  async willUpdate(changedProperties: PropertyValues) {
    if (!this.isLocal) {
      this.manifest = await getServerMapMetadata(this.mapName)
      this.image = await getServerMapImage(this.mapName)
    } else {
      try {
        const localMapData = (await loadMapFromLocalStorage(this.mapName)) as unknown as {
          manifest: MapManifest
          thumbnail: string
        }
        if (localMapData) {
          this.manifest = localMapData.manifest
          this.image = localMapData.thumbnail || ''
        } else {
          this.manifest = {
            name: this.mapName,
            description: 'Local map',
            width: 0,
            height: 0,
            nations: []
          } as any
        }
      } catch (error) {
        this.manifest = {
          name: this.mapName,
          description: 'Local map (corrupted)',
          width: 0,
          height: 0,
          nations: []
        } as any
      }
    }
  }

  readableName(s: string) {
    return s
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .replace(/[a-z][A-Z]/g, (char) => `${char[0]} ${char[1]}`)
  }

  handleSelect = (e: Event) => {
    e.stopPropagation()
    const fullMapName = this.isLocal ? `local:${this.mapName}` : this.mapName
    this.emit('select', { mapName: fullMapName })
  }

  render() {
    if (!this.manifest) return nothing
    return html`
      <e-button
        classes="block relative w-full h-12 p-4 overflow-hidden"
        ?active=${this.isSelected}
        @click=${this.handleSelect}
      >
        <div class="font-medium text-editor-text w-full text-left z-10 text-white" style="text-shadow: 0 0 6px black;">
          ${this.readableName(this.isLocal ? this.mapName : this.manifest.name)}
        </div>
        <only-show .if=${this.isLocal && !this.isDeleting}>
          <e-button
          classes="absolute top-0 right-0 z-20"
          variant="danger"
          .icon=${!this.isDeleting ? '🗑️' : '...'}
          @click=${(e: Event) => this.handleDeleteMap(this.mapName, e)}
          title="Delete this map"
          ></e-button>
      </only-show>
      <only-show .if=${this.image} class="absolute top-0 left-0 w-full h-12 bg-gradient-to-b from-editor-primary to-editor-primary-hover">
        <img src=${this.image} alt=${this.manifest.name} class="w-full" />
      </only-show>
    </e-button>
    `
  }
}

@customElement('load-map-loading-indicator')
export class LoadMapLoadingIndicator extends TailwindElement {
  render() {
    return html`
      <div class="animate-spin">🔄</div>
    `
  }
}

@customElement('load-map-refresh-button')
export class LoadMapRefreshButton extends TailwindElement {
  @property({ type: Function }) handleRefresh: () => void
  render() {
    return html`
      <e-button class="text-editor-text hover:text-editor-primary transition-colors" @click=${this.handleRefresh} title="Refresh local maps">🔄</e-button>
    `
  }
}
