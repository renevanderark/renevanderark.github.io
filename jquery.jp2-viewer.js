window.requestAnimFrame = (function(){
	return window.requestAnimationFrame       ||
		window.webkitRequestAnimationFrame ||
		window.mozRequestAnimationFrame    ||
		function( callback ){
			window.setTimeout(callback, 1000 / 60);
		};
})();


(function ( $ ) {
	$.fn.jp2MinimapEvents = function(opts) {
		if(!opts.viewer) { return; }
		var viewerScale;
		var viewerPosition;
		var _self = this;
		var dragging = false;
		var scale = 1.0;
		var rect;

		var viewerDimensions = {
			w: opts.viewer.get(0).width,
			h: opts.viewer.get(0).height
		};

		this.on("mousedown", function(e) {
			dragging = true;
			$(this).css({ cursor: "move" });
			return false;
		});

		this.on("mousedown mousemove", function(e) {
			if(dragging) {
				var x = (e.pageX - _self.offset().left) + $(window).scrollLeft() - ((rect.w * scale) / 2);
				var y = (e.pageY - _self.offset().top) + $(window).scrollTop() - ((rect.h * scale) / 2);
				opts.viewer.trigger("moveTo", { 
					x: Math.floor(x / scale), 
					y: Math.floor(y / scale)
				});
			}
			return false;
		});

		this.on("mouseup mouseout", function(e) {
			dragging = false;
			$(this).css({ cursor: "default" });
			return false;
		});

		this.on("fullyLoaded", function(e, props) {
			scale = props.scale;
			drawRect();
		});

		this.on("setViewerProperties", function(e, props) {
			viewerScale = props.scale;
			viewerPosition = props.pos;
			viewerRotation = props.rot;
			drawRect();
		});

		function drawRect() {
			_self.trigger("refresh");
			rect = {
				x: Math.floor(viewerPosition.x > 0 ? 0 : -(viewerPosition.x) / viewerScale),
				y: Math.floor(viewerPosition.y > 0 ? 0 : -(viewerPosition.y) / viewerScale),
				w: Math.ceil(viewerDimensions.w / viewerScale),
				h: Math.ceil(viewerDimensions.h / viewerScale)
			};

			switch(viewerRotation) {
				case 90: 
				case 270: 
					var swp1 = rect.w; rect.w = rect.h; rect.h = swp1; 
					break;
				default:
			}


			_self.trigger("drawRect", rect);
		}

		return this;
	};

	$.fn.jp2ViewerEvents = function(opts) {
		var curX;
		var curY;
		var dragging = false;

		this.on("mousedown", function(e) {
			dragging = true;
			curX = e.clientX;
			curY = e.clientY;

			$(this).css({ cursor: "move" });
			return false;
		});

		this.on("mousemove", function(e) {
			if(dragging) {
				$(this).trigger("moveBy", { 
					x: curX - e.clientX, 
					y: curY - e.clientY
				});
				curX = e.clientX;
				curY = e.clientY;
			}
		});

		this.on("mouseup mouseout", function(e) {
			dragging = false;
			$(this).css({ cursor: "default" });
			return false;
		});

		this.on("mousewheel", function(e, delta, deltaX, deltaY) {
			if(delta > 0) {
				$(this).trigger("scaleBy", 1.1);
			} else if(delta < 0) {
				$(this).trigger("scaleBy", 0.9);
			}
			return false;
		});
		return this;
	};

	$.fn.jp2Viewer = function(options) {
		var opts = options || opts;
		var canvas = this.get(0);
		var ctx = canvas.getContext('2d');
		var bufcan = $("<canvas>").get(0);
		var buffer = bufcan.getContext('2d');
		var filename = opts.filename || false;
		var url = opts.url || false;
		var dataType = opts.dataType || "json";
		var primary = opts.primary || "http://" + window.location.hostname + "/cgi-bin/jp2";
		var workers = opts.workers || [{address: primary, cores: 1}]; 
		var initScale = opts.initScale || "full-width";
		var _self = this;
		var _baseParams = {};
		if(filename) { _baseParams = {f: filename}; }
		else if(url) { _baseParams = {u: url }; }
		else { return; }

		if(opts.useMemcached) { _baseParams.m = 1; }

		var jp2Header = false;
		var tiles = {};

		var scale;
		var reduction;
		var reductionScale;
		var currentWorker = 0;
		var xPos = 0;
		var yPos = 0;
		var oldX;
		var oldY;

		var rotation = 0;

		var loadTrigger = false;
		var showTrigger = false;
		var incompleteTiles = [];

		bufcan.width = canvas.width;
		bufcan.height = canvas.height;
		ctx.fillStyle = buffer.fillStyle = opts.backgroundColor || "#aaa";

		this.on("moveBy", function(e, dims) {
			var movX = dims.x;
			var movY = dims.y;
			switch(rotation) {
				case 90: var swp = movX; movX = movY; movY = -swp; break;
				case 180: movX = -movX; movY = -movY; break;
				case 270: var swp = movX; movX = -movY; movY = swp; break;
				default:
			}

			xPos -= movX;
			yPos -= movY;
			ensureBounds();
			showImage();
			loadTrigger = true;
		});

		this.on("moveTo", function(e, realPos) {
			xPos = -realPos.x * scale;
			yPos = -realPos.y * scale;
			ensureBounds();
			showImage();
			loadTrigger = true;
		});

		this.on("scaleBy", function(e, s) {
			xPos *= s; yPos *= s;
			initScale = scale * s;
			initialize();
		});

		this.on("rotateBy", function(e, rot) {
			rot = rotation + rot;
			if(rot < 0)  { rot = 270; }
			if(rot > 270) { rot = 0; }
			setRotation(rot);
		});

		this.on("refresh", function(e) { 
			showImage();
		});

		this.on("drawRect", function(e, realDims) {
			ctx.beginPath();
			ctx.rect(realDims.x * scale, realDims.y * scale, realDims.w * scale, realDims.h * scale);
			ctx.stroke();
		});

		function setRotation(rot) {
			rotation = rot;
			if(rotation == 90 || rotation == 270) {
				bufcan.width = canvas.height;
				bufcan.height = canvas.width;
			} else {
				bufcan.width = canvas.width;
				bufcan.height = canvas.height;
			}
			buffer.fillStyle = opts.backgroundColor || "#aaa";
			ensureBounds();
			loadImage();
		}

		function ensureBounds() {
			if(xPos + (jp2Header.x1 * scale) <= bufcan.width) { xPos = bufcan.width - (jp2Header.x1 * scale); }
			if(yPos + (jp2Header.y1 * scale) <= bufcan.height) { yPos = bufcan.height - (jp2Header.y1 * scale); }
			if(xPos > 0) { xPos = 0; }
			if(yPos > 0) { yPos = 0; }
			if(jp2Header.x1 * scale <= bufcan.width) { 
				xPos = Math.floor((bufcan.width - jp2Header.x1 * scale) / 2);
			}
			if(jp2Header.y1 * scale <= bufcan.height) { 
				yPos = Math.floor((bufcan.height - jp2Header.y1 * scale) / 2);
			}

		}

		function reduce(val, reduction) {
			if(reduction == 0) { return val; }
			return reduce(val / 2, --reduction);
		}

		function setScale(s) {
			switch(s) {
				case "full-width": scale =  canvas.width / jp2Header.x1; break;
				case "full-height": scale = canvas.height / jp2Header.y1; break;
				default: 
					scale = parseFloat(s);
					if(scale == 0.0) { scale = 1.0; }
			}
		}

		function setReduction(s) {
			var s = s || scale;
			reduction = jp2Header.num_res;
			while(--reduction) {
				if(reduce(1.0, reduction) > s) { 
					break; 
				}
			}
		}

		function initializeTiles() {
			for(var i = 0; i < jp2Header.num_res; i++) {
				tiles["redux-" + i] = [];
			}
		}

		function drawTile(tile) {
			if(tile.dims.r != reduction) { return; }
			if(tile.img.complete) {
				buffer.drawImage(
					tile.img, tile.dims.x, tile.dims.y, 
					Math.ceil(tile.img.width * tile.dims.s), 
					Math.ceil(tile.img.height * tile.dims.s));
			} else {
				buffer.fillRect(tile.dims.x, tile.dims.y, jp2Header.tdx * tile.dims.s, jp2Header.tdy * tile.dims.s);
				incompleteTiles.push(tile);
			}
		}

		function clearSurroundings(xCorrection, yCorrection) {
			var ch = canvas.height;
			var cw = canvas.width;
			if(rotation == 90 || rotation == 270) {
				cw = canvas.height;
				ch = canvas.width;
			}
			if(jp2Header.x1 * scale <= cw) { 
				ctx.clearRect(xCorrection || 0, yCorrection ||	 0, xPos, ch);
				ctx.clearRect(cw - xPos - 1 + (xCorrection || 0), (yCorrection || 0), xPos + 1, ch);
			}

			if(jp2Header.y1 * scale <= ch) { 
				ctx.clearRect(xCorrection || 0, yCorrection || 0, cw, yPos);
				ctx.clearRect((xCorrection || 0), ch - yPos - 1 + (yCorrection || 0), cw, yPos + 1);
			}
		}

		function loadImage(_hidden) {
			var tileS = scale / reduce(1.0, reduction);
			var ch = canvas.height;
			var cw = canvas.width;
			if(rotation == 90 || rotation == 270) { var swp = cw; cw = ch; ch = swp; }
			var tilesX = Math.ceil(cw / (jp2Header.tdx * scale)) + 1;
			var tilesY = Math.ceil(ch / (jp2Header.tdy * scale)) + 1;
			var tileX = Math.floor(-xPos / (jp2Header.tdx * scale));
			var tileY = Math.floor(-yPos / (jp2Header.tdy * scale));

			if(tileX < 0) { tileX = 0; }
			if(tileY < 0) { tileY = 0; }

			if(tileX + tilesX > jp2Header.tw)  { tilesX = jp2Header.tw - tileX; }
			if(tileY + tilesY > jp2Header.th)  { tilesY = jp2Header.th - tileY; }

			for(var x = tileX; x < tileX + tilesX; x++) {
				for(var y = tileY; y < tileY + tilesY; y++) {
					var tileIndex = x + (y * jp2Header.tw);

					if(tiles["redux-" + reduction][tileIndex]) {
						tiles["redux-" + reduction][tileIndex].dims = { 
							x: xPos + Math.floor(x * (jp2Header.tdx * scale)), 
							y: yPos + Math.floor(y * (jp2Header.tdy * scale)),
							tx: x, 
							ty: y,
							s: tileS,
							r: reduction
						};
						drawTile(tiles["redux-" + reduction][tileIndex]);
					} else {
						var tile = { 
							img: new Image(),
							dims:  { 
								x: xPos + Math.floor(x * (jp2Header.tdx * scale)), 
								y: yPos + Math.floor(y * (jp2Header.tdy * scale)),
								tx: x, 
								ty: y,
								s: tileS,
								r: reduction
							}
						}
						tiles["redux-" + reduction][tileIndex] = tile;
						tile.img.src = workers[currentWorker].address + "?" + $.param($.extend({
							t: tileIndex,
							r: reduction,
							n: jp2Header.num_comps
						}, _baseParams));
						drawTile(tile);
					}

					if(++currentWorker == workers.length) { currentWorker = 0; }
				}
			}
			showImage();
		}

		function initialize(__init) {
			jp2Header = __init || jp2Header;
			setScale(initScale);
			setReduction();
			if(__init) { initializeTiles(); }
			if(opts.wrapImage) { canvas.height = jp2Header.y1 * scale; canvas.width = jp2Header.x1 * scale; }
			ensureBounds();
			loadImage();
		}

		function showImage() {
			ctx.save();
			ctx.translate(canvas.width / 2, canvas.height / 2);
			ctx.rotate(rotation * (Math.PI / 180));
			ctx.drawImage(bufcan, -bufcan.width / 2, -bufcan.height / 2);
			clearSurroundings(-bufcan.width / 2, -bufcan.height / 2);
			ctx.restore();

			if(opts.miniMap) { updateMinimap(); }
		}

		function updateMinimap() {
			opts.miniMap.trigger("setViewerProperties", {
				scale: scale, 
				pos: {x: xPos, y: yPos},
				rot: rotation
			}); 
		}

		function drawIncompleteTiles() {
			var i = incompleteTiles.length;
			if(i == 0) { 
				_self.trigger("fullyLoaded", { scale: scale });
				return; 
			}
			while(--i > -1) {
				if(incompleteTiles[i].img.complete) {
					incompleteTiles[i].dims.x = xPos + Math.floor(incompleteTiles[i].dims.tx * (jp2Header.tdx * scale));
					incompleteTiles[i].dims.y = yPos + Math.floor(incompleteTiles[i].dims.ty * (jp2Header.tdy * scale)),
					incompleteTiles[i].dims.s = scale / reduce(1.0, reduction);

					drawTile(incompleteTiles[i]);
					incompleteTiles.splice(i, 1);
				}
			}
			showImage();
		}

		function preloadHiddenTile() {
			for(var x = 0; x < jp2Header.tw; x++) {
				for(var y = 0; y < jp2Header.th; y++) {
					var tileIndex = x + (y * jp2Header.tw);
					if(!tiles["redux-" + reduction][tileIndex]) {
						tiles["redux-" + reduction][tileIndex] = { img: new Image() };
						tiles["redux-" + reduction][tileIndex].img.src = workers[currentWorker].address + "?" + $.param($.extend({
							t: tileIndex,
							r: reduction,
							n: jp2Header.num_comps
						}, _baseParams));

						return;
					}
				}
			}
		}

		function monitorTiles() {
			requestAnimFrame(monitorTiles);
			if(!jp2Header) { return; }
			if(loadTrigger) { loadImage(); loadTrigger = false; }
			drawIncompleteTiles();
			if(incompleteTiles.length == 0) {
				if(opts.onready) { opts.onready(); opts.onready = false; }
				preloadHiddenTile();
			}
		}

		monitorTiles();

		$.ajax(primary, {
			data: _baseParams,
			dataType: opts.dataType,
			success: initialize
		});
		return this;
	};
}( jQuery ));
