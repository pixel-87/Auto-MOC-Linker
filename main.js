const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');

class AutoMOCLinkerPlugin extends Plugin {
    async onload() {
        console.log('Loading Auto MOC Linker plugin');

        // Initialize cache
        this.fileCache = {};
        this.mocLinksCache = {};
        this.totalNotesAdded = 0; // Global counter
        
        // Load settings
        await this.loadSettings();

        // Add settings tab
        this.addSettingTab(new AutoMOCLinkerSettingTab(this.app, this));

        // Register the command to run the indexing
        this.addCommand({
            id: 'run-auto-moc-linker',
            name: 'Run Auto MOC Linker',
            callback: () => this.runAutoIndex()
        });
        
        // Listen for file modifications to update cache
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file && file.path && this.fileCache[file.path]) {
                delete this.fileCache[file.path];
            }
        }));
        
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file && file.path) {
                delete this.fileCache[file.path];
            }
        }));
    }

    async loadSettings() {
        this.settings = Object.assign({
            tagMappings: [],
            defaultPath: '/',
            appendFormat: '- [[{{fileName}}]]\n',
            sectionHeading: '## Links',
            batchSize: 50 // Process files in batches
        }, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Helper function to ensure .md extension
    ensureMdExtension(path) {
        if (!path) return path;
        if (path.toLowerCase().endsWith('.md')) return path;
        return path + '.md';
    }

    async runAutoIndex() {
        const { vault } = this.app;
        const searchPath = this.settings.defaultPath || '/';
        this.totalNotesAdded = 0; // Reset global counter
        let filesProcessed = 0;
        
        // Get all markdown files in the specified path
        let files = await this.getFilesInPath(searchPath);
        const totalFiles = files.length;
        
        // Show initial progress
        new Notice(`Auto MOC Linker: Processing ${totalFiles} files...`);
        
        // Create a mapping of MOC files to their current links (lazily loaded)
        this.mocLinksCache = {}; // Reset cache for this run
        
        // Process files in batches to reduce memory pressure
        const batchSize = this.settings.batchSize;
        
        for (let i = 0; i < totalFiles; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            await this.processBatch(batch);
            
            filesProcessed += batch.length;
            if (filesProcessed % 100 === 0 || filesProcessed === totalFiles) {
                new Notice(`Auto MOC Linker: Processed ${filesProcessed}/${totalFiles} files...`);
            }
        }

        // Use the global counter for the final notification
        new Notice(`Auto MOC Linker complete: Added ${this.totalNotesAdded} notes to MOCs`);
        console.log(`Auto MOC Linker complete: Added ${this.totalNotesAdded} notes to MOCs`);
    }
    
    async processBatch(files) {
        // Process each file in the batch
        for (const file of files) {
            if (file.extension !== 'md') continue;
            
            // Use cached file data if available, otherwise read and cache
            if (!this.fileCache[file.path]) {
                try {
                    const content = await this.app.vault.read(file);
                    this.fileCache[file.path] = {
                        content: content,
                        tags: this.extractTags(content)
                    };
                } catch (e) {
                    console.error(`Failed to read file ${file.path}`, e);
                    continue;
                }
            }
            
            const fileData = this.fileCache[file.path];
            const tags = fileData.tags;
            
            if (tags.length === 0) continue; // Skip files with no tags
            
            // Check each tag for matching mappings
            for (const tag of tags) {
                const tagWithoutHash = tag.startsWith('#') ? tag.substring(1) : tag;
                
                // Find mappings that match this tag
                const matchingMappings = this.settings.tagMappings.filter(mapping => {
                    const mappingTag = mapping.tag.startsWith('#') ? mapping.tag.substring(1) : mapping.tag;
                    return mappingTag === tagWithoutHash;
                });
                
                if (matchingMappings.length === 0) continue;
                
                // Process mappings directly without tracking return value
                // The global counter will be incremented in processTagMappings
                await this.processTagMappings(file, matchingMappings);
            }
        }
    }
    
    async processTagMappings(file, mappings) {
        const { vault } = this.app;
        
        for (const mapping of mappings) {
            if (!mapping.mocPath) continue;
            
            try {
                // Ensure the MOC path has .md extension
                const mocPath = this.ensureMdExtension(mapping.mocPath);
                
                const mocFile = this.app.vault.getAbstractFileByPath(mocPath);
                if (!mocFile) {
                    console.log(`MOC file not found at: ${mocPath}`);
                    continue;
                }
                
                // Lazy load MOC links
                if (!this.mocLinksCache[mocPath]) {
                    try {
                        const mocContent = await vault.read(mocFile);
                        this.mocLinksCache[mocPath] = {
                            content: mocContent,
                            links: this.extractExistingLinks(mocContent)
                        };
                    } catch (e) {
                        console.error(`Failed to read MOC at ${mocPath}`, e);
                        continue;
                    }
                }
                
                const mocData = this.mocLinksCache[mocPath];
                const links = mocData.links;
                const fileName = file.basename;
                
                // Check if the file is already linked
                if (links.includes(fileName)) continue;
                
                // Add link to MOC
                const newLink = this.settings.appendFormat.replace('{{fileName}}', fileName);
                const sectionHeading = this.settings.sectionHeading || '## Links';
                const updatedContent = this.addLinkToMOC(mocData.content, newLink, sectionHeading);
                
                // Log before modification for debugging
                console.log(`Adding link to ${fileName} in ${mocPath}`);
                
                await vault.modify(mocFile, updatedContent);
                
                // Increment the global counter directly
                this.totalNotesAdded++;
                
                // Log after modification for debugging
                console.log(`Added link to ${fileName} in ${mocPath} - total: ${this.totalNotesAdded}`);
                
                // Update the cache
                this.mocLinksCache[mocPath] = {
                    content: updatedContent,
                    links: [...links, fileName]
                };
            } catch (e) {
                console.error(`Error processing mapping for ${mapping.mocPath}`, e);
            }
        }
    }
    
    addLinkToMOC(content, newLink, sectionHeading) {
        // This function is simpler and shouldn't create performance issues
        const headingRegex = new RegExp(`^${sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
        
        if (headingRegex.test(content)) {
            return content.replace(headingRegex, `${sectionHeading}\n${newLink}`);
        } else {
            return content + `\n\n${sectionHeading}\n${newLink}`;
        }
    }

    async getFilesInPath(path) {
        const { vault } = this.app;
        let files = [];
        
        // More efficient file collection using TFile array
        if (path === '/') {
            // Get all markdown files in vault more efficiently
            files = vault.getMarkdownFiles();
        } else {
            // Only process files in the specified path
            const targetFolder = vault.getAbstractFileByPath(path);
            if (targetFolder && targetFolder.children) {
                const collectFiles = (folder) => {
                    for (const child of folder.children) {
                        if (child.children) {
                            collectFiles(child);
                        } else if (child.extension === 'md') {
                            files.push(child);
                        }
                    }
                };
                
                collectFiles(targetFolder);
            }
        }
        
        return files;
    }

    extractTags(content) {
        let tags = [];
        
        // Optimize frontmatter tag extraction by using less resource-intensive regex
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontmatterMatch && frontmatterMatch[1]) {
            const frontmatter = frontmatterMatch[1];
            
            // Use simpler regex patterns and avoid redundant processing
            // Single tag
            const singleTagMatch = frontmatter.match(/tags\s*:\s*([^\n\[\]]+)(?:\n|$)/);
            if (singleTagMatch && singleTagMatch[1]) {
                tags.push(singleTagMatch[1].trim());
            }
            
            // Inline array - use simpler approach
            const inlineArrayMatch = frontmatter.match(/tags\s*:\s*\[(.*?)\]/);
            if (inlineArrayMatch && inlineArrayMatch[1]) {
                inlineArrayMatch[1].split(',')
                    .map(tag => tag.trim())
                    .filter(tag => tag.length > 0)
                    .forEach(tag => tags.push(tag));
            }
            
            // Multiline tags - use simpler approach
            const lines = frontmatter.split('\n');
            let inTagsBlock = false;
            for (const line of lines) {
                if (line.match(/^tags\s*:/)) {
                    inTagsBlock = true;
                    continue;
                }
                
                if (inTagsBlock) {
                    const tagMatch = line.match(/^\s*-\s*(.+)$/);
                    if (tagMatch) {
                        tags.push(tagMatch[1].trim());
                    } else if (!line.trim().startsWith('-')) {
                        inTagsBlock = false;
                    }
                }
            }
        }
        
        // Extract inline tags from body - using non-global regex with string splitting
        // This is more efficient than using a global regex with exec
        const bodyTags = content.split('#')
            .slice(1) // Skip the part before first #
            .map(part => {
                const match = part.match(/^([a-zA-Z0-9_-]+)/);
                return match ? match[1] : null;
            })
            .filter(tag => tag !== null);
        
        tags = [...tags, ...bodyTags];
        
        return tags;
    }

    extractExistingLinks(content) {
        // More efficient link extraction
        const links = [];
        const sections = content.split('[[');
        
        for (let i = 1; i < sections.length; i++) {
            const endIdx = sections[i].indexOf(']]');
            if (endIdx !== -1) {
                const link = sections[i].substring(0, endIdx);
                const cleanLink = link.split('|')[0].trim();
                links.push(cleanLink);
            }
        }
        
        return links;
    }
}

class AutoMOCLinkerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        let { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Auto MOC Linker Settings' });

        // Default search path setting
        new Setting(containerEl)
            .setName('Default Search Path')
            .setDesc('The path to search for notes (/ for entire vault)')
            .addText(text => text
                .setPlaceholder('/')
                .setValue(this.plugin.settings.defaultPath)
                .onChange(async (value) => {
                    this.plugin.settings.defaultPath = value;
                    await this.plugin.saveSettings();
                }));

        // Append format setting
        new Setting(containerEl)
            .setName('Append Format')
            .setDesc('Format to use when appending notes to MOCs. Use {{fileName}} as placeholder.')
            .addText(text => text
                .setPlaceholder('- [[{{fileName}}]]')
                .setValue(this.plugin.settings.appendFormat)
                .onChange(async (value) => {
                    this.plugin.settings.appendFormat = value;
                    await this.plugin.saveSettings();
                }));

        // Section heading setting
        new Setting(containerEl)
            .setName('Section Heading')
            .setDesc('Heading under which links will be added (e.g., "## Links" or "#### Other Notes")')
            .addText(text => text
                .setPlaceholder('## Links')
                .setValue(this.plugin.settings.sectionHeading)
                .onChange(async (value) => {
                    this.plugin.settings.sectionHeading = value;
                    await this.plugin.saveSettings();
                }));

        // Performance settings
        new Setting(containerEl)
            .setName('Batch Size')
            .setDesc('Number of files to process at once (lower number uses less memory)')
            .addSlider(slider => slider
                .setLimits(10, 200, 10)
                .setValue(this.plugin.settings.batchSize || 50)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.batchSize = value;
                    await this.plugin.saveSettings();
                }));

        // Tag to MOC mappings
        containerEl.createEl('h3', { text: 'Tag to MOC Mappings', cls: 'moc-mapping-header' });
        
        // Create a div to contain all mappings
        const mappingsContainer = containerEl.createDiv({ cls: 'moc-mappings-container' });

        this.plugin.settings.tagMappings.forEach((mapping, i) => {
            const mappingContainer = mappingsContainer.createDiv({ cls: 'moc-mapping-item' });
            
            new Setting(mappingContainer)
                .setClass('moc-mapping-setting')
                .setName(`Mapping ${i + 1}`)
                .addText(text => text
                    .setPlaceholder('Tag (e.g., #maths)')
                    .setValue(mapping.tag)
                    .onChange(async (value) => {
                        this.plugin.settings.tagMappings[i].tag = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder('MOC path (without .md extension)')
                    .setValue(mapping.mocPath ? mapping.mocPath.replace(/\.md$/i, '') : '')
                    .onChange(async (value) => {
                        // Store the path without enforcing .md extension
                        this.plugin.settings.tagMappings[i].mocPath = value;
                        await this.plugin.saveSettings();
                    }))
                .addButton(button => button
                    .setButtonText('Remove')
                    .setClass('moc-remove-button')
                    .onClick(async () => {
                        this.plugin.settings.tagMappings.splice(i, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));
        });

        // Add new mapping button
        new Setting(containerEl)
            .setClass('moc-add-mapping-button')
            .addButton(button => button
                .setButtonText('Add New Mapping')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.tagMappings.push({
                        tag: '',
                        mocPath: ''
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }
}

module.exports = AutoMOCLinkerPlugin;