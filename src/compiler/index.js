var htmlparser = require('htmlparser2');
var _ = require('underscore');
var utils = require('../utils');
var strFnObj = require('../serializer');
var log4js = require('log4js');
var logger = log4js.getLogger('[VueServer Compile]');

var noCloseTags = {
    input: true,
    img: true,
    br: true,
    hr: true,
    meta: true,
    link: true
};

var directiveOptions = {
    'v-model': ['lazy', 'number', 'options', 'debounce'],
    'v-repeat': ['track-by'],
    'v-component': ['keep-alive', 'transition-mode', 'inline-template']
};

var parsers = {
    directive: require('./../parsers/directive'),
    expression: require('./../parsers/expression'),
    path: require('./../parsers/path'),
    text: require('./../parsers/text')
};

var tokensToFn = function(tokens) {
    var expr = parsers.text.tokensToExp(tokens);
    return parsers.expression.parse(expr).get;
};

var textToFn = function(text) {
    var tokens = parsers.text.parse(text);
    var expr = parsers.text.tokensToExp(tokens);
    return parsers.expression.parse(expr).get;
};

var parseDirective = function(value) {
    var result = parsers.directive.parse(value);
    var error = false;

    result.forEach(function(item) {
        if (error) {
            return;
        }

        var parsedExp = parsers.expression.parse(item.expression);
        if (!parsedExp) {
            logger.warn('Invalid expression: "' + item.expression + '"');
            error = true;
            result = false;
            return;
        }
        item.get = parsedExp.get;
        delete item.raw;
    });

    return result;
};

var getMetaValue = function(value) {
    var result = [];
    var tokens = parsers.text.parse(value);
    var error = false;

    if (tokens) {
        tokens.forEach(function(token) {
            if (error) {
                return;
            }
            
            if (token.tag) {
                // var exp = parsers.text.tokensToExp([token]);
                // var parsedExp = parsers.expression.parse(exp);
                // var item = {
                //     value: {
                //         get: parsedExp.get
                //     },
                //     isEscape: token.html ? false : true,
                //     isClean: true
                // }

                
                var parsedToken = parsers.directive.parse(token.value)[0];
                var exp = parsers.expression.parse(parsedToken.expression);

                if (!exp) {
                    logger.warn('Invalid expression: "' + parsedToken.expression + '"');
                    error = true;
                    result = false;
                    return;
                }
                var item = {
                    value: exp.get,
                    isEscape: token.html ? false : true,
                    isClean: true
                };

                if (parsedToken.filters) {
                    item.filters = parsedToken.filters;
                }
                result.push(item);
            } else {
                result.push({
                    value: token.value,
                    isEscape: false,
                    isClean: false
                });
            }
        });

        if (result && result.length === 1) {
            return result[0];
        } else {
            return result;
        }

    } else {
        if (value === 'true') {
            return true;
        }
        if (value === 'false') {
            return false;
        }
        if (Number(value) == value && !(Number(value) === 0 && value !== '0')) {
            return Number(value);
        }

        return value;
    }
};

var makeTxtNode = function(current, value) {
    if (value) {
        current.inner.push({
            'type': 'text',
            'text': getMetaValue(value)
        });
    }
};



var getElementId = function() {
    var result = '';
    var time = process.hrtime();
    result += String(time[0]).slice(5) + time[1];
    return result;
};




var bindRE = /^:|^v-bind:/;
var refRE = /^:|^v-ref:/;
var elRE = /^:|^v-el:/;
var onRE = /^@/;
var argRE = /:(.*)$/;



// Конвертируем голый HTML в специальное дерево массивов-объектов
var Compile = function(template) {
    if (template === undefined || template === null) {
        template = '';
    }

    if (typeof template !== 'string') {
        console.log('vue-html-compile: template is not fit for compiling');
        return template;
    }
    
    var mass = {'inner': []},
        current = mass,
        preIsActive = false,

        // Индикатор углубление в dom tree относительно директивы v-pre
        // нужно, чтобы знать, когда снять флаг preIsActive
        preIsActiveDepth = 0;


    var repeatItems = [];





    var parser = new htmlparser.Parser({
        onopentag: function(name, attribs) {
            var element;

            if ('v-pre' in attribs && !preIsActive) {
                element = {
                    'type': 'text',
                    'text': '',
                    'parent': current
                };

                preIsActive = true;
                element.pre = true;

                current.inner.push(element);

                current = element;

                _.each(attribs, function(attrVal, attr) {
                    // Удаляем из дерева vue-директивы
                    if ( attr.match(/^v-/) ) {
                        delete attribs[attr];
                    }
                });
            }


            // Если элемент находится внутри директивы v-pre
            if (preIsActive) {
                preIsActiveDepth++;

                var tag = '<' + name;

                for (var key in attribs) {
                    tag += ' ' + key + '=\"' + attribs[key] + '\"';
                }

                tag += '>';

                current.text += tag;

            } else {

                // COMMON TAG - begin
                element = {
                    'id': getElementId(),
                    'type': 'tag',
                    'name': name,
                    'attribs': {},
                    'inner': [],
                    'dirs': {},
                    'parent': current,
                    'close': true,
                    'pre': false
                };


                // Теги, которые не должны иметь закрывающего тега
                if ( noCloseTags[element.name] ) {
                    element.close = false;
                }


                var attribsForExclude = {};
                var attribsCounter = 0;

                _.each(attribs, function(value, name) {
                    // v-bind
                    if (name.match(bindRE)) {
                        (function() {
                            var attr = name.match(argRE)[1].replace(/\.sync$|\.once$/, '');

                            element.dirs.bind = element.dirs.bind || [];

                            var dirValue = parseDirective(attribs[name]);

                            if (dirValue) {
                                element.dirs.bind.push({
                                    name: attr,
                                    value: dirValue[0]
                                });
                            }
                        })();
                    }

                    // v-ref:name
                    if (name.match(refRE)) {
                        (function() {
                            var ref = name.match(argRE)[1];

                            if (ref) {
                                element.dirs.ref = {
                                    value: ref,
                                    options: {
                                        target: '$refs'
                                    }
                                };
                            }
                        })();
                    }

                    // v-el:name
                    if (name.match(elRE)) {
                        (function() {
                            var el = name.match(argRE)[1];

                            if (el) {
                                element.dirs.el = {
                                    value: el,
                                    options: {
                                        target: '$els'
                                    }
                                };
                            }
                        })();
                    }

                    // v-for
                    if (name === 'v-for') {
                        (function() {
                            var rawValue = parseDirective(attribs['v-for']);

                            if (rawValue) {
                                rawValue = rawValue[0];

                                var args = rawValue.expression.split(' in ');

                                element.dirs.repeat = {
                                    value: {
                                        arg: args[0],
                                        expression: args[1],
                                        get: textToFn('{{' + args[1] + '}}')
                                    },
                                    options: {
                                        vFor: true
                                    }
                                };

                                if (rawValue.filters) {
                                    element.dirs.repeat.value.filters = rawValue.filters;
                                }

                                repeatItems.push(element);
                            }
                        })();

                    }


                    if (name === 'v-else') {
                        // Ищим ближайший тег, проверяем его на v-if
                        (function() {
                            for (var i = current.inner.length - 1; i >= 0; i--) {
                                if (current.inner[i].type === 'tag') {
                                    if (current.inner[i].dirs && current.inner[i].dirs.if) {
                                        var vIfDir = parseDirective('!(' + current.inner[i].dirs.if.value.expression + ')');
                                        if (vIfDir) {
                                            element.dirs.if = {
                                                value: vIfDir[0]
                                            };
                                        }
                                    }
                                    break;
                                }
                            }
                        })();
                    }




                    if (name === 'v-text') {
                        var vTextDir = parseDirective(attribs['v-text']);
                        if (vTextDir) {
                            element.dirs.text = {
                                value: vTextDir[0]
                            };
                        }
                    }

                    if (name === 'v-html') {
                        var vHtmlDir = parseDirective(attribs['v-html']);
                        if (vHtmlDir) {
                            element.dirs.html = {
                                value: vHtmlDir[0]
                            };
                        }
                    }

                    if (name === 'v-if') {
                        var vIfDir = parseDirective(attribs['v-if']);
                        if (vIfDir) {
                            element.dirs.if = {
                                value: vIfDir[0]
                            };
                        }
                    }

                    if (name === 'v-model') {
                        var vModelDir = parseDirective(attribs['v-model']);
                        if (vModelDir) {
                            element.dirs.model = {
                                value: vModelDir[0],
                                options: {}
                            };

                            if (attribs['options']) {
                                var vModelDirOptions = parseDirective(attribs['options']);
                                if (vModelDirOptions) {
                                    element.dirs.model.options.options = vModelDirOptions[0];
                                }
                            }
                        }
                    }

                    if (name === 'v-component') {
                        (function() {
                            element.dirs.component = {
                                options: {}
                            };

                            var tokens = parsers.text.parse(attribs['v-component']);

                            if (!tokens) {
                                element.dirs.component.value = attribs['v-component'].trim();
                            } else {
                                element.dirs.component.value = tokensToFn(tokens);
                            }
                        })();
                    }

                    if (name === 'v-repeat') {
                        var vRepeatDir = parseDirective(attribs['v-repeat']);
                        if (vRepeatDir) {
                            element.dirs.repeat = {
                                value: vRepeatDir[0]
                            };
                            repeatItems.push(element);
                        }
                    }

                    if (name === 'v-with') {
                        var vWithDir = parseDirective(attribs['v-with']);
                        if (vWithDir) {
                            element.dirs.with = {
                                value: vWithDir
                            };
                        }
                    }

                    if (name === 'v-class') {
                        var vClassDir = parseDirective(attribs['v-class'])

                        if (vClassDir) {
                            element.dirs.class = {
                                value: null
                            };

                            // Когда классы в самой директивы
                            if (vClassDir[0].arg) {
                                element.dirs.class.value = vClassDir;

                            // Когда в директиву передаём объект
                            } else {
                                element.dirs.class.value = parsers.expression.parse(vClassDir[0].expression);
                            }
                        }
                    }


                    if (name === 'v-style') {
                        var vStyleDir = parseDirective(attribs['v-style'])

                        if (vStyleDir) {
                            element.dirs.style = {
                                value: null,
                                order: attribsCounter
                            };

                            // Когда классы в самой директивы
                            if (vStyleDir[0].arg) {
                                element.dirs.style.value = vStyleDir;

                            // Когда в директиву передаём объект
                            } else {
                                element.dirs.style.value = parsers.expression.parse(vStyleDir[0].expression);
                            }
                        }
                    }


                    if (name === 'v-attr') {
                        var vAttrDir = parseDirective(attribs['v-attr']);
                        if (vAttrDir) {
                            element.dirs.attr = {
                                value: vAttrDir
                            };
                        }
                    }

                    if (name === 'v-show') {
                        var vShowDir = parseDirective(attribs['v-show']);
                        if (vShowDir) {
                            element.dirs.show = {
                                value: vShowDir[0],
                                order: attribsCounter
                            };
                        }
                    }

                    if (name === 'v-ref') {
                        element.dirs.ref = {
                            value: attribs['v-ref'],
                            options: {
                                target: '$'
                            }
                        };
                    }

                    if (name === 'v-el') {
                        element.dirs.el = {
                            value: attribs['v-el'],
                            options: {
                                target: '$$'
                            }
                        };
                    }


                    // Аттрибуты-опции директив, которые нужны будет исключить из списка атрибутов
                    if (directiveOptions[name]) {
                        directiveOptions[name].forEach(function(item) {
                            attribsForExclude[item] = true;
                        });
                    }

                    attribsCounter++;
                });



                _.each(attribs, function(value, name) {
                    // Удаляем из дерева vue-директивы кроме v-clock (нефиг их рендерить)
                    if ( 
                        ( !name.match(/^v-/) || name.match(/^v-cloak$/) ) &&
                        !name.match(/^:(.+)/) &&
                        !name.match(onRE) &&
                        !attribsForExclude[name]
                    ) {
                        element.attribs[name] = getMetaValue(value);
                    }
                });


                // Кишки от директивы v-attr
                if (element.dirs.attr) {
                    element.dirs.attr.value.forEach(function(item) {
                        element.attribs[item.arg] = {
                            value: item.get
                        };
                    });
                }

                // Убираем пустой объект dirs из тега
                if (!_.size(element.dirs)) {
                    delete element.dirs;
                }


                current.inner.push(element);

                current = element;
                // COMMON TAG - end
            }

        },

        ontext: function(text) {
            var caret;

            // Если элемент находится внутри директивы v-pre
            if (preIsActive) {
                current.text += text;

            } else {
                makeTxtNode( current, text.substring(caret, text.length) );
            }

        },

        onclosetag: function(name) {
            var now;

            // Если элемент находится внутри директивы v-pre
            if (preIsActive) {
                // На каждом закрывающем теге мы поднимаемся вверх по дереву
                // Как только preIsActiveDepth станет пустым, это будет означать, что мы достигли элемента
                // на котором началась директива v-pre
                preIsActiveDepth--;

                if ( noCloseTags[name] ) {
                    current.text += '</' + name + '>';
                }
            } 

            if (!preIsActive || !preIsActiveDepth) {
                preIsActive = false;

                now = current;
                current = current.parent;

                delete now.parent;
            }
        },

        // тут идёт доктайп
        onprocessinginstruction: function(name, data) {
            // Если элемент находится внутри директивы v-pre
            if (preIsActive) {
                current.text += '<' + data + '>';

            } else {
                current.inner.push({
                    'type': 'text',
                    'text': '<' + data + '>'
                });
            }
        },

        // Сюда так же идут conditional comments
        // Нужно ли здесь вводить обработку выражений? а хз
        oncomment: function(data) {
            if (preIsActive) {
                current.text += '<!-- ' + data + ' -->';
            } else {
                if ( data.match(/^\[CDATA\[/) && data.match(/\]\]$/) ) {
                    current.inner.push({
                        'type': 'text',
                        'text': '<!' + data + '>'
                    }); 
                } else {
                    current.inner.push({
                        'type': 'text',
                        'text': '<!-- ' + data + ' -->'
                    }); 
                }
            }
        },

        onerror: function(error) {
            utils.warn(error);
        }
    },
    {
        // xmlMode: true
        lowerCaseTags: false
    });
    parser.write(template);
    parser.end();


    for (var i = repeatItems.length - 1; i >= 0; i--) {
        var clone = new Function( 'return ' + strFnObj( repeatItems[i] ) );
        repeatItems[i].clone = clone;
    }
    

    return new Function( 'return ' + strFnObj(mass.inner) );
};




module.exports = Compile;