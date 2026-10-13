'use strict';

const avatarPattern = /\b(avatar|profile\s*(photo|image|picture)?|user\s*(photo|image|picture)?|pfp)\b/i;

function attributeName(attribute) {
  return attribute && attribute.type === 'JSXAttribute' && attribute.name
    ? attribute.name.name
    : null;
}

function stringValue(node) {
  if (!node) {
    return '';
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }

  if (node.type === 'JSXExpressionContainer') {
    return stringValue(node.expression);
  }

  if (node.type === 'TemplateLiteral') {
    return node.quasis.map((quasi) => quasi.value.cooked || '').join(' ');
  }

  if (node.type === 'Literal' && typeof node.value === 'number') {
    return String(node.value);
  }

  return '';
}

function isImgElement(node) {
  return node.name && node.name.type === 'JSXIdentifier' && node.name.name === 'img';
}

function isAvatarComponentFile(filename) {
  return /(?:^|[/\\])AvatarWithBadge\.tsx$/u.test(filename)
    || /(?:^|[/\\])avatar-with-badge\.tsx$/u.test(filename);
}

function hasAvatarSignal(node) {
  return node.attributes.some((attribute) => {
    const name = attributeName(attribute);

    if (name !== 'alt' && name !== 'className') {
      return false;
    }

    return avatarPattern.test(stringValue(attribute.value));
  });
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'disallow bare img tags for avatar imagery',
    },
    messages: {
      noBareAvatarImg: 'Avatar images must use AvatarWithBadge instead of a bare <img>.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.getFilename();

    if (isAvatarComponentFile(filename)) {
      return {};
    }

    return {
      JSXOpeningElement(node) {
        if (isImgElement(node) && hasAvatarSignal(node)) {
          context.report({
            node,
            messageId: 'noBareAvatarImg',
          });
        }
      },
    };
  },
};
