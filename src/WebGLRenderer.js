'use strict';

var INDICES        = 'indices';

var BUFFER_DATA = 'BUFFER_DATA';
var UNIFORM_INPUT = 'UNIFORM_INPUT';
var MATERIAL_INPUT = 'MATERIAL_INPUT';
var GL_SPEC = 'GL_SPEC';

var FRAME_END = 'FRAME_END';

var Texture = require('./Texture');
var Program = require('./Program');
var Buffer = require('./Buffer');

var BufferRegistry = require('./BufferRegistry');

var uniformNames = ['perspective', 'transform', 'opacity', 'origin', 'size', 'baseColor'];
var resolutionName = ['resolution'];
var uniformValues = [];
var resolutionValues = [];

var inputIdx = { baseColor: 0, normal: 1, metalness: 2, glossiness: 3 };
var inputNames = ['baseColor', 'normal', 'metalness', 'glossiness'];
var inputValues = [[.5, .5, .5], [0,0,0], .2, .8];
var identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * WebGLRenderer is a private class that reads commands from a Mesh
 * and converts them into webGL api calls.
 *
 * @class WebGLRenderer
 * @constructor
 *
 * @param {DOMElement} canvas The dom element that GL will paint itself onto.
 *
 */

function WebGLRenderer(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');

    if (this.container.getTarget() === document.body) {
        window.addEventListener('resize', this.updateSize.bind(this));
    }

    this.container.getTarget().appendChild(this.canvas);
    this.canvas.className = 'famous-webgl GL';

    var context = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
    var containerSize = this.container._getSize();

    var gl = this.gl = context;

    gl.polygonOffset(0.1, 0.1);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthFunc(gl.LEQUAL);

    this.meshRegistry = {};
    this.lightRegistry = {};
    this.textureRegistry = {};
    this.texCache = {};
    this.bufferRegistry = new BufferRegistry(gl);
    this.program = new Program(gl);

    this.state = {
        boundArrayBuffer: null,
        boundElementBuffer: null,
        lastDrawn: null,
        enabledAttributes: {}
    };

    this.cachedSize = [];
    this.updateSize(containerSize[0], containerSize[1], containerSize[2], this.container);

    this.projectionTransform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * Draws a mesh onto the screen
 *
 * @method render
 *
 * @param {Context} object with local transform data and mesh
 *
 * @chainable
 */

WebGLRenderer.prototype.receive = function receive(path, commands) {
    var mesh = this.meshRegistry[path];
    var light = this.lightRegistry[path];

    if (!mesh) {
        mesh = this.meshRegistry[path] = {
            uniformKeys: ['opacity', 'transform', 'size', 'origin', 'baseColor'],
            uniformValues: [1, identity, [0, 0, 0], [0, 0, 0], [0.5, 0.5, 0.5]],
            buffers: {},
            geometry: null,
            drawType: null
        };
    }
    var bufferName;
    var bufferValue;
    var bufferSpacing;
    var uniformName;
    var uniformValue;
    var geometryId;

    while (commands.length) {
        var command = commands.shift();

        switch (command) {

            case 'GL_CREATE_LIGHT':
                light = this.lightRegistry[path] = {
                    color: [1.0, 1.0, 1.0],
                    position: [0.0, 0.0, 100.0]
                };
                break;

            case 'GL_LIGHT_POSITION':
                var transform = commands.shift();
                light.position[0] = transform[12];
                light.position[1] = transform[13];
                light.position[2] = transform[14];
                break;

            case 'GL_LIGHT_COLOR':
                var color = commands.shift();
                light.color[0] = color[0];
                light.color[1] = color[1];
                light.color[2] = color[2];
                break;

            case 'MATERIAL_INPUT':
                var name = commands.shift();
                var mat = commands.shift();
                mesh.uniformValues[4][0] = -mat._id;
                this.program.registerMaterial(name, mat);
                this.updateSize();
                break;

            case 'UNIFORM_INPUT':
                var name = commands.shift();
                var mat = commands.shift();
                mesh.uniformValues[4] = mat;
                break;

            case 'GL_SET_GEOMETRY':
                mesh.geometry = commands.shift();
                mesh.drawType = commands.shift();
                mesh.dynamic = commands.shift();
                break;

            case 'GL_UNIFORMS':
                uniformName = commands.shift();
                uniformValue = commands.shift();
                var index = mesh.uniformKeys.indexOf(uniformName);
                if (index === -1) {
                    mesh.uniformKeys.push(uniformName);
                    mesh.uniformValues.push(uniformValue);
                } else {
                    mesh.uniformValues[index] = uniformValue;
                }
                break;

            case 'GL_BUFFER_DATA':
                geometryId = commands.shift();
                bufferName = commands.shift();
                bufferValue = commands.shift();
                bufferSpacing = commands.shift();

                this.bufferRegistry.allocate(geometryId, bufferName, bufferValue, bufferSpacing, mesh.dynamic);
                break;

            case 'WITH': commands.unshift(command); return;
        }
    }
};

WebGLRenderer.prototype.draw = function draw() {
    var mesh;
    var buffers;
    var size;
    var light;

    for(var key in this.lightRegistry) {
        light = this.lightRegistry[key];
        this.program.setUniforms(['u_LightPosition'], [light.position]);
        this.program.setUniforms(['u_LightColor'], [light.color]);
    }

    this.program.setUniforms(['perspective'], [this.projectionTransform]);

    for (var key in this.meshRegistry) {
        mesh = this.meshRegistry[key];

        buffers = this.bufferRegistry.registry[mesh.geometry];
        if (!buffers) return;

        this.program.setUniforms(mesh.uniformKeys, mesh.uniformValues);
        this.drawBuffers(buffers, mesh.drawType, mesh.geometry);
    }
};


/**
 * Loads the buffers and issues the draw command for a geometry
 *
 * @method drawBuffers
 *
 * @param {Object} Map of vertex buffers keyed by attribute identifier
 * @param {Number} Enumerator defining what primitive to draw
 *
 */
WebGLRenderer.prototype.drawBuffers = function drawBuffers(vertexBuffers, mode, id) {
    var gl = this.gl;
    var length = 0;
    var attribute;
    var location;
    var spacing;
    var offset;
    var buffer;
    var iter;
    var j;

    iter = vertexBuffers.keys.length;
    for (var i = 0; i < iter; i++) {
        attribute = vertexBuffers.keys[i];

        // Do not set vertexAttribPointer if index buffer.

        if (attribute === INDICES) {
            j = i; continue;
        }

        // Retreive the attribute location and make sure it is enabled.

        location = this.program.attributeLocations[attribute];

        if (location === -1) continue;
        if (location === undefined) {
            location = gl.getAttribLocation(this.program.program, attribute);
            this.program.attributeLocations[attribute] = location;
            if (location === -1) continue;
        }

        if (!this.state.enabledAttributes[attribute]) {
            gl.enableVertexAttribArray(location);
            this.state.enabledAttributes[attribute] = true;
        }

        // Retreive buffer information used to set attribute pointer.

        buffer = vertexBuffers.values[i];
        spacing = vertexBuffers.spacing[i];
        offset = vertexBuffers.offset[i];
        length = vertexBuffers.length[i];

        // Skip bindBuffer if buffer is currently bound.

        if (this.state.boundArrayBuffer !== buffer) {
            gl.bindBuffer(buffer.target, buffer.buffer);
            this.state.boundArrayBuffer = buffer;
        }

        if (this.state.lastDrawn !== id) {
            gl.vertexAttribPointer(location, spacing, gl.FLOAT, gl.FALSE, 0, 4 * offset);
        }
    }

    // Disable any attributes that not currently being used.

    for(var attribute in this.state.enabledAttributes) {
        if (this.state.enabledAttributes[attribute] && vertexBuffers.keys.indexOf(attribute) === -1) {
            gl.disableVertexAttribArray(this.program.attributeLocations[attribute]);
            this.state.enabledAttributes[attribute] = false;
        }
    }

    if (length) {

        // If index buffer, use drawElements.

        if (j !== undefined) {
            buffer = vertexBuffers.values[j];
            offset = vertexBuffers.offset[j];
            spacing = vertexBuffers.spacing[j];
            length = vertexBuffers.length[j];

            // Skip bindBuffer if buffer is currently bound.

            if (this.state.boundElementBuffer !== buffer) {
                gl.bindBuffer(buffer.target, buffer.buffer);
                this.state.boundElementBuffer = buffer;
            }

            gl.drawElements(mode, length, gl.UNSIGNED_SHORT, 2 * offset);
        }
        else {
            gl.drawArrays(mode, 0, length);
        }
    }

    this.state.lastDrawn = id;
};

/**
 * Allocates an array buffer where vertex data is sent to via compile.
 *
 * @method renderOffscreen
 *
 * @param {Function} The render function to be called after setup and before cleanup
 * @param {spec} The object containing mesh data
 * @param {context} The object containing global render information
 * @param {Texture} The location where the render data is stored
 *
 */

function renderOffscreen(callback, spec, context, texture) {
    var gl = this.gl;
    var v = context._size;

    var framebuffer  = this.framebuffer ? this.framebuffer : this.framebuffer = gl.createFramebuffer();
    var renderbuffer = this.renderbuffer ? this.renderbuffer : this.renderbuffer = gl.createRenderbuffer();

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);

    if (v[0] != renderbuffer.width || v[1] != renderbuffer.height) {
        renderbuffer.width = v[0];
        renderbuffer.height = v[1];
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, v[0], v[1]);
    }

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.id, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);

    if (this.debug) checkFrameBufferStatus(gl);

    callback.call(this, spec);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
};

/**
 * Uploads an image if it is a string
 *
 * @method loadImage
 *
 * @param {Object, String} image object or string url
 * @param {Function} proc that gets called when the image is loaded
 *
 */
function loadImage (img, callback) {
    var obj = (typeof img === 'string' ? new Image() : img) || {};
    obj.crossOrigin = 'anonymous';
    if (! obj.src) obj.src = img;
    if (! obj.complete) obj.onload = function () { callback(obj); };
    else callback(obj);

    return obj;
}

/**
 * Diagonose the failed intialization of an FBO
 *
 * @method checkFrameBufferStatus
 *
 * @param {Object} the glContext that owns this FBO
 *
 */
function checkFrameBufferStatus(gl) {
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

    switch (status) {
        case gl.FRAMEBUFFER_COMPLETE:
            break;
        case gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT:
            throw("Incomplete framebuffer: FRAMEBUFFER_INCOMPLETE_ATTACHMENT"); break;
        case gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:
            throw("Incomplete framebuffer: FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT"); break;
        case gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS:
            throw("Incomplete framebuffer: FRAMEBUFFER_INCOMPLETE_DIMENSIONS"); break;
        case gl.FRAMEBUFFER_UNSUPPORTED:
            throw("Incomplete framebuffer: FRAMEBUFFER_UNSUPPORTED"); break;
        default:
            throw("Incomplete framebuffer: " + status);
    }
};

/**
 * Updates the width and height of parent canvas, sets the viewport size on
 * the WebGL context and updates the resolution uniform for the shader program.
 * If no size is passed in this function will update using the cached size.
 *
 * @method updateSize
 *
 * @param {Number} width Updated width of the drawing context.
 * @param {Number} height Updated height of the drawing context.
 * @param {Number} depth Updated depth of the drawing context.
 *
 */
WebGLRenderer.prototype.updateSize = function updateSize() {
    var newSize = this.container._getSize();

    var width = newSize[0];
    var height = newSize[1];

    this.cachedSize[0] = width;
    this.cachedSize[1] = height;
    this.cachedSize[2] = (width > height) ? width : height;

    this.canvas.width  = width;
    this.canvas.height = height;

    this.gl.viewport(0, 0, this.cachedSize[0], this.cachedSize[1]);

    resolutionValues[0] = this.cachedSize;
    this.program.setUniforms(resolutionName, resolutionValues);
};

module.exports = WebGLRenderer;

